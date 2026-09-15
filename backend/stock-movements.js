const { query, withTransaction, ensureSchema } = require("./pg");
const {
  ITEMS_PER_PAGE,
  toEmagDatetime,
  resolveEmagAuth,
  emagOrderRead,
} = require("./emag-client");
const { log } = require("./logs-db");

// Statusuri eMAG: 0 anulata, 1 noua, 2 in lucru, 3 pregatita, 4 finalizata, 5 returnata.
const ORDER_CANCELED = 0;
// Linie de produs: 1 activa, 0 scoasa din comanda.
const LINE_ACTIVE = 1;
const SINCE_KEY = "emag_stock_orders_since";

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sumMoney(items, field) {
  let total = 0;
  for (const it of items) total += (toNum(it?.[field]) || 0) * (toNum(it?.quantity) ?? 1);
  return Math.round(total * 10000) / 10000;
}

/**
 * Momentul de la care comenzile scad stocul. Setat o singura data (prima rulare),
 * ca poller-ul sa nu scada stoc pentru comenzi vechi care doar si-au schimbat statusul.
 */
async function stockSince(client) {
  await client.query(
    `INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    [SINCE_KEY, new Date().toISOString()]
  );
  const { rows } = await client.query(`SELECT value FROM app_meta WHERE key = $1`, [SINCE_KEY]);
  return rows[0].value;
}

async function findCatalogProduct(client, p) {
  const offerId = p?.product_id != null ? String(p.product_id) : null;
  if (offerId) {
    const direct = await client.query(
      `SELECT id FROM catalog_products WHERE emag_offer_id = $1 LIMIT 1`,
      [offerId]
    );
    if (direct.rows[0]) return direct.rows[0].id;
    const listing = await client.query(
      `SELECT product_id FROM marketplace_listings
       WHERE channel = 'emag' AND external_id = $1 AND product_id IS NOT NULL LIMIT 1`,
      [offerId]
    );
    if (listing.rows[0]) return listing.rows[0].product_id;
  }
  if (p?.part_number) {
    const byPn = await client.query(
      `SELECT id FROM catalog_products WHERE part_number = $1 LIMIT 1`,
      [String(p.part_number)]
    );
    if (byPn.rows[0]) return byPn.rows[0].id;
  }
  return null;
}

async function upsertOrderHeader(client, order, products, via) {
  const customer = Array.isArray(order.customer) ? order.customer[0] : order.customer;
  const vouchers = Array.isArray(order.vouchers) ? order.vouchers : [];
  const active = products.filter((p) => Number(p.status) === LINE_ACTIVE);
  const productsTotal = sumMoney(active, "sale_price");
  const productsTotalVat = Math.round(
    active.reduce(
      (s, p) => s + (toNum(p.sale_price) || 0) * (toNum(p.quantity) || 0) * (1 + (toNum(p.vat) || 0)),
      0
    ) * 10000
  ) / 10000;
  const vouchersTotal = vouchers.reduce((s, v) => s + (toNum(v.sale_price_vat) ?? toNum(v.sale_price) ?? 0), 0);

  await client.query(
    `INSERT INTO emag_orders
       (order_id, status, order_date, modified_at, payment_mode_id, payment_mode, customer_name,
        currency, products_total, products_total_vat, shipping_tax, vouchers_total, raw, received_via)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (order_id) DO UPDATE SET
       status = EXCLUDED.status,
       order_date = EXCLUDED.order_date,
       modified_at = EXCLUDED.modified_at,
       payment_mode_id = EXCLUDED.payment_mode_id,
       payment_mode = EXCLUDED.payment_mode,
       customer_name = EXCLUDED.customer_name,
       currency = EXCLUDED.currency,
       products_total = EXCLUDED.products_total,
       products_total_vat = EXCLUDED.products_total_vat,
       shipping_tax = EXCLUDED.shipping_tax,
       vouchers_total = EXCLUDED.vouchers_total,
       raw = EXCLUDED.raw,
       updated_at = now()`,
    [
      order.id,
      toNum(order.status),
      order.date || order.created || null,
      order.modified || null,
      toNum(order.payment_mode_id),
      order.payment_mode || null,
      customer?.name || customer?.billing_name || null,
      products[0]?.currency || "RON",
      productsTotal,
      productsTotalVat,
      toNum(order.shipping_tax),
      vouchersTotal,
      JSON.stringify(order),
      via,
    ]
  );
}

async function upsertLine(client, order, p, catalogProductId) {
  await client.query(
    `INSERT INTO order_line_history
       (line_id, order_id, product_id, part_number, name, quantity, sale_price, status,
        currency, order_date, vat, catalog_product_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (line_id) DO UPDATE SET
       order_id = EXCLUDED.order_id,
       product_id = EXCLUDED.product_id,
       part_number = EXCLUDED.part_number,
       name = EXCLUDED.name,
       quantity = EXCLUDED.quantity,
       sale_price = EXCLUDED.sale_price,
       status = EXCLUDED.status,
       currency = EXCLUDED.currency,
       order_date = EXCLUDED.order_date,
       vat = EXCLUDED.vat,
       catalog_product_id = EXCLUDED.catalog_product_id`,
    [
      p.id,
      order.id,
      toNum(p.product_id),
      p.part_number || "",
      p.name || p.product_name || "",
      toNum(p.quantity),
      toNum(p.sale_price),
      toNum(p.status),
      p.currency || "RON",
      order.date || order.created || null,
      toNum(p.vat),
      catalogProductId,
    ]
  );
}

/** Aplica delta pe stocul local si completeaza miscarea cu stoc inainte/dupa. */
async function applyDelta(client, movementId, productId, offerId, delta) {
  const before = await client.query(
    `SELECT general_stock FROM catalog_products WHERE id = $1 FOR UPDATE`,
    [productId]
  );
  const stockBefore = toNum(before.rows[0]?.general_stock);
  const after = await client.query(
    `UPDATE catalog_products
     SET general_stock = GREATEST(COALESCE(general_stock, 0) + $2, 0), updated_at = now()
     WHERE id = $1 RETURNING general_stock`,
    [productId, delta]
  );
  await client.query(
    `UPDATE stock_movements SET stock_before = $2, stock_after = $3 WHERE id = $1`,
    [movementId, stockBefore, toNum(after.rows[0]?.general_stock)]
  );
  if (offerId) {
    await client.query(
      `UPDATE emag_stock_snapshot
       SET general_stock = GREATEST(COALESCE(general_stock, 0) + $2, 0), seen_at = now()
       WHERE offer_id = $1`,
      [offerId, delta]
    );
  }
}

async function insertMovement(client, { productId, orderId, lineId, offerId, kind, delta, note }) {
  const { rows } = await client.query(
    `INSERT INTO stock_movements (product_id, channel, order_id, line_id, offer_id, kind, delta, note)
     VALUES ($1, 'emag', $2, $3, $4, $5, $6, $7)
     ON CONFLICT (channel, order_id, line_id, kind) WHERE kind IN ('order', 'order-cancel')
     DO NOTHING
     RETURNING id`,
    [productId, orderId, lineId, offerId, kind, delta, note || null]
  );
  return rows[0]?.id ?? null;
}

/**
 * Salveaza comanda (antet + linii cu pret) si ajusteaza stocul local:
 * linie activa → scade o singura data; comanda anulata / linie scoasa → restituie.
 */
async function applyEmagOrder(order, { via = "webhook" } = {}) {
  await ensureSchema();
  if (!order || order.id == null) throw new Error("Comanda fara id");
  const products = Array.isArray(order.products) ? order.products : [];
  const orderId = String(order.id);
  const summary = { order_id: order.id, status: order.status, deducted: [], restored: [], unmatched: [] };

  await withTransaction(async (client) => {
    const since = await stockSince(client);
    const { rows: recentRows } = await client.query(
      `SELECT ($1::timestamp AT TIME ZONE 'Europe/Bucharest') >= $2::timestamptz AS recent`,
      [order.date || order.created || new Date().toISOString(), since]
    );
    const isRecent = recentRows[0]?.recent === true;

    await upsertOrderHeader(client, order, products, via);

    for (const p of products) {
      const lineId = String(p.id);
      const offerId = p.product_id != null ? String(p.product_id) : null;
      const qty = toNum(p.quantity) || 0;
      const productId = await findCatalogProduct(client, p);
      await upsertLine(client, order, p, productId);

      const lineActive = Number(order.status) !== ORDER_CANCELED && Number(p.status) === LINE_ACTIVE;

      if (lineActive) {
        if (!isRecent || qty <= 0) continue;
        const movementId = await insertMovement(client, {
          productId,
          orderId,
          lineId,
          offerId,
          kind: "order",
          delta: productId ? -qty : 0,
          note: productId ? null : "produs negasit in catalog",
        });
        if (!movementId) continue; // deja procesata
        if (productId) {
          await applyDelta(client, movementId, productId, offerId, -qty);
          summary.deducted.push({ line_id: p.id, product_id: productId, qty });
        } else {
          summary.unmatched.push({ line_id: p.id, offer_id: offerId, part_number: p.part_number });
        }
        continue;
      }

      // Anulare: restituim doar ce am scazut efectiv.
      const { rows: prev } = await client.query(
        `SELECT product_id, stock_before, stock_after FROM stock_movements
         WHERE channel = 'emag' AND order_id = $1 AND line_id = $2 AND kind = 'order'`,
        [orderId, lineId]
      );
      const deducted = prev[0];
      if (!deducted || !deducted.product_id) continue;
      // Stocul e limitat la 0, deci scaderea efectiva poate fi mai mica decat cantitatea.
      const restoreQty = (toNum(deducted.stock_before) ?? 0) - (toNum(deducted.stock_after) ?? 0);
      if (restoreQty <= 0) continue;
      const movementId = await insertMovement(client, {
        productId: deducted.product_id,
        orderId,
        lineId,
        offerId,
        kind: "order-cancel",
        delta: restoreQty,
      });
      if (!movementId) continue;
      await applyDelta(client, movementId, deducted.product_id, offerId, restoreQty);
      summary.restored.push({ line_id: p.id, product_id: deducted.product_id, qty: restoreQty });
    }
  });

  if (summary.deducted.length || summary.restored.length || summary.unmatched.length) {
    void log({
      level: summary.unmatched.length ? "warn" : "info",
      source: "server",
      category: "webhook-emag",
      message:
        `[${via}] comanda ${order.id}: scazut ${summary.deducted.length}, ` +
        `restituit ${summary.restored.length}, negasite ${summary.unmatched.length}`,
      detail: summary,
    });
  }
  return summary;
}

/** Citeste o comanda din eMAG (retry cu auth proaspat la 401/403). */
async function fetchEmagOrders(context, params) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await resolveEmagAuth(context, { fresh: attempt > 0 });
    const { response, json, text } = await emagOrderRead(auth, params);
    if ((response.status === 401 || response.status === 403) && attempt === 0) continue;
    if (!json) throw new Error(`Răspuns invalid eMAG (HTTP ${response.status}): ${text.slice(0, 300)}`);
    if (json.isError) throw new Error(`eMAG eroare: ${JSON.stringify(json.messages || [])}`);
    return Array.isArray(json.results) ? json.results : [];
  }
  throw new Error("Autentificare eMAG eșuată");
}

async function processEmagOrderId(orderId, { via = "webhook" } = {}) {
  const orders = await fetchEmagOrders("webhook", { id: orderId });
  const order = orders.find((o) => String(o.id) === String(orderId)) || orders[0];
  if (!order) throw new Error(`Comanda ${orderId} nu a fost gasita in eMAG`);
  return applyEmagOrder(order, { via });
}

/** Poller de rezerva: comenzile modificate in ultimele `lookbackMinutes` minute. */
async function pollRecentEmagOrders({ lookbackMinutes = 30 } = {}) {
  const modifiedAfter = toEmagDatetime(new Date(Date.now() - lookbackMinutes * 60 * 1000));
  let processed = 0;
  for (let page = 1; ; page++) {
    const orders = await fetchEmagOrders("order-poll", { page, modifiedAfter });
    for (const order of orders) {
      await applyEmagOrder(order, { via: "poll" });
      processed += 1;
    }
    if (orders.length < ITEMS_PER_PAGE) break;
  }
  return processed;
}

async function listLocalOrders({ from, to, page = 1, limit = 50 } = {}) {
  await ensureSchema();
  const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
  const offset = (Math.max(1, Number(page) || 1) - 1) * safeLimit;
  const { rows: orders } = await query(
    `SELECT order_id, status, order_date, modified_at, payment_mode, customer_name, currency,
            products_total, products_total_vat, shipping_tax, vouchers_total, received_via,
            created_at, updated_at
     FROM emag_orders
     WHERE ($1::timestamptz IS NULL OR order_date >= $1)
       AND ($2::timestamptz IS NULL OR order_date <= $2)
     ORDER BY order_date DESC NULLS LAST, order_id DESC
     LIMIT $3 OFFSET $4`,
    [from || null, to || null, safeLimit, offset]
  );
  if (orders.length === 0) return [];
  const { rows: lines } = await query(
    `SELECT order_id, line_id, product_id AS offer_id, catalog_product_id, part_number, name,
            quantity, sale_price, vat, status, currency
     FROM order_line_history WHERE order_id = ANY($1::int[]) ORDER BY line_id`,
    [orders.map((o) => o.order_id)]
  );
  const byOrder = new Map();
  for (const l of lines) {
    if (!byOrder.has(String(l.order_id))) byOrder.set(String(l.order_id), []);
    byOrder.get(String(l.order_id)).push(l);
  }
  return orders.map((o) => ({ ...o, products: byOrder.get(String(o.order_id)) || [] }));
}

/** Comenzi noi dupa un watermark created_at — fara linii, pentru notificari browser. */
async function listNewLocalOrders({ afterCreatedAt, limit = 20 } = {}) {
  await ensureSchema();
  const { rows: nowRows } = await query(`SELECT now() AS server_time`);
  const serverTime = nowRows[0]?.server_time;
  if (!afterCreatedAt) {
    return { serverTime, orders: [] };
  }
  const after = new Date(afterCreatedAt);
  if (Number.isNaN(after.getTime())) {
    return { serverTime, orders: [] };
  }
  const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 50);
  const { rows } = await query(
    `SELECT order_id, status, order_date, customer_name, currency, products_total, created_at
     FROM emag_orders
     WHERE created_at > $1
     ORDER BY created_at ASC, order_id ASC
     LIMIT $2`,
    [after.toISOString(), safeLimit]
  );
  return { serverTime, orders: rows };
}

async function listStockMovements({ limit = 100 } = {}) {
  await ensureSchema();
  const { rows } = await query(
    `SELECT m.*, c.nume, c.cod_produs
     FROM stock_movements m LEFT JOIN catalog_products c ON c.id = m.product_id
     ORDER BY m.created_at DESC LIMIT $1`,
    [Math.min(Math.max(1, Number(limit) || 100), 1000)]
  );
  return rows;
}

module.exports = {
  applyEmagOrder,
  processEmagOrderId,
  pollRecentEmagOrders,
  listLocalOrders,
  listNewLocalOrders,
  listStockMovements,
};
