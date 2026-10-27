/**
 * Citiri din Base (BaseLinker), doar ca aplicația să vadă profitul și stocul real.
 * Nimic nu pleacă spre Base de aici: Base ține comenzile și stocul pe toate canalele.
 *
 * - Comenzile eMAG (sursele `emagro` / `emaghu` / `emagbg`) intră în emag_orders +
 *   order_line_history, pentru Statistici, Apeluri review și istoricul produsului.
 *   Stocul local NU se atinge (orders-db.js scrie doar comanda). Trendyol nu intră,
 *   ca și înainte: statisticile sunt doar pe eMAG.
 * - Returnările din Base marchează comanda cu status 5 (returnată).
 * - Stocul din depozitul Base (BASE_WAREHOUSE) se copiază în catalog_products.general_stock,
 *   după SKU (cod_produs).
 */
const { query } = require("./pg");
const base = require("./base-client");
const { saveOrder } = require("./orders-db");
const { log } = require("./logs-db");

const LOOKBACK_HOURS = Number(process.env.BASE_ORDER_LOOKBACK_HOURS ?? 72);
const POLL_MINUTES = Number(process.env.BASE_SYNC_MINUTES ?? 10);
const TZ = "Europe/Bucharest";

// Statusurile eMAG: 0 anulată, 1 nouă, 3 pregătită, 4 finalizată (5 returnată vine din returnări).
const STATUS_BY_NAME = [
  [/anulat|cancel|storn/i, 0],
  [/^trimis|livrat|finaliz/i, 4],
  [/de trimis|pregat/i, 3],
];

let statusCache = null;
/** id status Base → status eMAG, după numele statusurilor (definite de tine în Base). */
async function statusMap() {
  if (statusCache) return statusCache;
  const data = await base.call("getOrderStatusList");
  statusCache = new Map();
  for (const s of data.statuses || []) {
    const hit = STATUS_BY_NAME.find(([re]) => re.test(String(s.name || "").trim()));
    statusCache.set(Number(s.id), hit ? hit[1] : 1);
  }
  return statusCache;
}

function platformOf(order) {
  const m = String(order.order_source || "").toLowerCase().match(/^emag(ro|hu|bg)$/);
  return m ? m[1] : null;
}

/** Ora locală, ca la comenzile citite direct din eMAG ("YYYY-MM-DD HH:MM:SS"). */
function localDate(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000).toLocaleString("sv-SE", { timeZone: TZ });
}

/** Comanda există deja, importată direct de la eMAG (înainte de Base)? */
async function importedDirectly(orderId) {
  const { rows } = await query(
    `SELECT 1 FROM emag_orders WHERE order_id = $1 AND received_via <> 'base' LIMIT 1`,
    [orderId]
  );
  return rows.length > 0;
}

/** Oferta eMAG a produsului după SKU, ca istoricul și comisionul să se lege ca la comenzile directe. */
async function offerIdsBySku(skus) {
  if (!skus.length) return new Map();
  const { rows } = await query(
    `SELECT cod_produs, emag_offer_id FROM catalog_products WHERE cod_produs = ANY($1::text[])`,
    [skus]
  );
  return new Map(rows.map((r) => [r.cod_produs, r.emag_offer_id]));
}

async function toEmagOrder(order, status) {
  const offers = await offerIdsBySku((order.products || []).map((p) => p.sku).filter(Boolean));
  return {
    id: Number(order.external_order_id),
    base_order_id: Number(order.order_id),
    status,
    date: localDate(order.date_add),
    customer: {
      name: order.delivery_fullname || order.invoice_fullname || "",
      phone: order.phone || null,
      email: order.email || null,
    },
    payment_mode: order.payment_method || null,
    shipping_tax: order.delivery_price ?? null,
    channel: "emag",
    products: (order.products || []).map((p) => {
      const vat = (Number(p.tax_rate) || 0) / 100;
      const offerId = offers.get(p.sku);
      return {
        // order_line_history.line_id e INTEGER; negativ ca să nu se lovească de id-urile eMAG.
        id: -Number(p.order_product_id),
        product_id: offerId ? Number(offerId) : null,
        sku: p.sku || null,
        part_number: p.sku || "",
        part_number_key: p.auction_id || null,
        name: p.name || "",
        quantity: Number(p.quantity) || 0,
        sale_price: (Number(p.price_brutto) || 0) / (1 + vat),
        vat,
        status: 1,
        currency: order.currency || "RON",
      };
    }),
  };
}

async function importOrder(order) {
  const platform = platformOf(order);
  if (!platform) return false;
  const status = (await statusMap()).get(Number(order.order_status_id)) ?? 1;
  const emagOrder = await toEmagOrder(order, status);
  if (!Number.isFinite(emagOrder.id) || emagOrder.id <= 0) return false;
  if (await importedDirectly(emagOrder.id)) {
    // Comanda veche (citită direct din eMAG) rămâne cum e; din Base ia doar anularea.
    if (status === 0) {
      await query(`UPDATE emag_orders SET status = 0, updated_at = now() WHERE order_id = $1 AND status <> 0`, [
        emagOrder.id,
      ]);
    }
    return false;
  }
  await saveOrder(emagOrder, { via: "base", platform });
  return true;
}

/** Comenzile din ultimele `hours` ore (Base dă câte 100; paginăm după id). */
async function syncOrders({ hours = LOOKBACK_HOURS } = {}) {
  const dateFrom = Math.floor(Date.now() / 1000) - hours * 3600;
  let idFrom = 0;
  let imported = 0;
  for (;;) {
    const params = { date_from: dateFrom, get_unconfirmed_orders: true };
    if (idFrom) params.id_from = idFrom;
    const orders = await base.getOrders(params);
    for (const o of orders) {
      try {
        if (await importOrder(o)) imported += 1;
      } catch (err) {
        void log({
          level: "error",
          source: "base",
          category: "orders",
          message: `Comanda Base ${o.order_id}: ${err.message}`,
          detail: { stack: err.stack },
        });
      }
    }
    if (orders.length < 100) break;
    idFrom = Math.max(...orders.map((o) => Number(o.order_id))) + 1;
  }
  return imported;
}

/** Returnările din Base → comanda originală devine status 5 (nu mai intră în vânzări). */
async function syncReturns({ hours = LOOKBACK_HOURS * 10 } = {}) {
  const data = await base.call("getOrderReturns", {
    date_from: Math.floor(Date.now() / 1000) - hours * 3600,
  });
  const baseIds = (data.returns || []).map((r) => Number(r.order_id)).filter((id) => id > 0);
  if (!baseIds.length) return 0;
  const { rowCount } = await query(
    `UPDATE emag_orders SET status = 5, updated_at = now()
     WHERE (raw->>'base_order_id')::bigint = ANY($1::bigint[]) AND status IS DISTINCT FROM 5`,
    [baseIds]
  );
  return rowCount;
}

/** Stocul din depozitul Base → general_stock, după SKU. */
async function syncStock() {
  const { inventoryId, warehouse } = base.config();
  const stockBySku = new Map();
  for (let page = 1; ; page++) {
    const data = await base.call("getInventoryProductsList", { inventory_id: inventoryId, page });
    const products = Object.values(data.products || {});
    for (const p of products) {
      if (p.sku) stockBySku.set(String(p.sku), Number(p.stock?.[warehouse]) || 0);
    }
    if (products.length < 1000) break;
  }
  if (!stockBySku.size) return [];
  const { rows } = await query(
    `UPDATE catalog_products c SET general_stock = s.stock, updated_at = now()
     FROM unnest($1::text[], $2::numeric[]) AS s(sku, stock)
     WHERE c.cod_produs = s.sku AND c.general_stock IS DISTINCT FROM s.stock
     RETURNING c.cod_produs, c.general_stock`,
    [[...stockBySku.keys()], [...stockBySku.values()]]
  );
  return rows;
}

async function syncAll(opts) {
  const imported = await syncOrders(opts);
  const returned = await syncReturns();
  const stock = await syncStock();
  if (imported || returned || stock.length) {
    void log({
      level: "info",
      source: "base",
      category: "sync",
      message: `Din Base: ${imported} comenzi, ${returned} returnări, ${stock.length} stocuri schimbate`,
      detail: { stock },
    });
  }
  return { imported, returned, stock: stock.length };
}

function startBaseSync() {
  if (!base.isConfigured()) {
    console.warn("[base-sync] Base neconfigurat — comenzile și stocul nu se citesc");
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncAll();
    } catch (err) {
      console.error("[base-sync]", err.message);
      void log({
        level: "error",
        source: "base",
        category: "sync",
        message: `Citirea din Base a eșuat: ${err.message}`,
        detail: { stack: err.stack },
      });
    } finally {
      running = false;
    }
  };
  setInterval(tick, POLL_MINUTES * 60 * 1000);
  setTimeout(tick, 15 * 1000);
  console.log(`[base-sync] comenzi + stoc din Base la fiecare ${POLL_MINUTES} min`);
}

module.exports = { syncOrders, syncReturns, syncStock, syncAll, startBaseSync };
