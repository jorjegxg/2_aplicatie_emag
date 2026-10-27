/**
 * Comenzile eMAG salvate local (emag_orders + order_line_history), doar pentru profit:
 * Statistici, Apeluri review și istoricul produsului. Vin din Base (base-sync.js).
 * Stocul nu se atinge aici: îl ține Base pe toate canalele.
 */
const { withTransaction, ensureSchema } = require("./pg");

// Linie de produs: 1 activa, 0 scoasa din comanda.
const LINE_ACTIVE = 1;
const PLATFORMS = ["ro", "hu", "bg"];

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
  // Comenzile venite prin Base au SKU-ul din catalog (cod_produs).
  if (p?.sku) {
    const bySku = await client.query(
      `SELECT id FROM catalog_products WHERE cod_produs = $1 LIMIT 1`,
      [String(p.sku)]
    );
    if (bySku.rows[0]) return bySku.rows[0].id;
  }
  return null;
}

async function upsertOrderHeader(client, order, products, via, platform) {
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

  const { rows } = await client.query(
    `INSERT INTO emag_orders
       (order_id, channel, status, order_date, modified_at, payment_mode_id, payment_mode, customer_name,
        currency, products_total, products_total_vat, shipping_tax, vouchers_total, raw, received_via,
        platform)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (order_id) DO UPDATE SET
       channel = EXCLUDED.channel,
       platform = EXCLUDED.platform,
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
       updated_at = now()
     RETURNING order_id, customer_name, currency, products_total, (xmax = 0) AS is_new`,
    [
      order.id,
      String(order.channel || "emag").trim().toLowerCase() || "emag",
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
      platform,
    ]
  );
  return rows[0] || null;
}

async function upsertLine(client, order, p, catalogProductId, platform) {
  await client.query(
    `INSERT INTO order_line_history
       (line_id, order_id, channel, product_id, part_number, name, quantity, sale_price, status,
        currency, order_date, vat, catalog_product_id, platform)
     VALUES ($1, $2, 'emag', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (line_id) DO UPDATE SET
       order_id = EXCLUDED.order_id,
       channel = EXCLUDED.channel,
       platform = EXCLUDED.platform,
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
      platform,
    ]
  );
}

/** Salveaza comanda (antet + linii cu pret). */
async function saveOrder(order, { via = "base", platform = "ro" } = {}) {
  await ensureSchema();
  if (!order || order.id == null) throw new Error("Comanda fara id");
  if (!PLATFORMS.includes(platform)) throw new Error(`Platforma eMAG necunoscuta: ${platform}`);
  const products = Array.isArray(order.products) ? order.products : [];
  await withTransaction(async (client) => {
    await upsertOrderHeader(client, order, products, via, platform);
    for (const p of products) {
      const productId = await findCatalogProduct(client, p);
      await upsertLine(client, order, p, productId, platform);
    }
  });
}

module.exports = { saveOrder };
