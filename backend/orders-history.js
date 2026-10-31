/**
 * Istoricul complet al comenzilor, doar citire:
 * - eMAG RO/HU/BG: order/read direct (comenzile de dinainte de Base nu sunt în Base).
 *   Se salvează ca la sincronizarea veche (emag_orders + order_line_history, via 'sync').
 *   Comenzile care au venit deja prin Base rămân cum sunt (liniile lor au alt id).
 * - Trendyol: GET /order/sellers/{id}/orders, în ferestre de 14 zile, în trendyol_order_lines.
 * - Trendyol din Base (base-sync): saveTrendyolFromBase, aceeași linie (lineId = transaction_id).
 */
const { query, ensureSchema } = require("./pg");
const { resolveEmagAuth, emagOrderRead, ITEMS_PER_PAGE } = require("./emag-client");
const { saveOrder } = require("./orders-db");
const { getTrendyolCreds, isTrendyolConfigured } = require("./credentials-store");
const { assertTrendyolReadOnly } = require("./direct-writes");
const { log } = require("./logs-db");

const TRENDYOL_API = "https://apigw.trendyol.com/integration";
const DAY_MS = 24 * 3600 * 1000;
// Primele comenzi sunt din iulie 2026; căutăm puțin mai devreme, ca să nu scape nimic.
const HISTORY_FROM = new Date(process.env.ORDERS_HISTORY_FROM || "2026-01-01T00:00:00Z");

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------- eMAG ------------------------------- */

async function importEmagHistory() {
  await ensureSchema();
  const auth = await resolveEmagAuth("orders-history");
  const createdAfter = HISTORY_FROM.toISOString().slice(0, 19).replace("T", " ");
  const { rows } = await query(`SELECT order_id FROM emag_orders WHERE received_via = 'base'`);
  const viaBase = new Set(rows.map((r) => String(r.order_id)));
  const result = {};
  for (const platform of ["ro", "hu", "bg"]) {
    let saved = 0;
    let skipped = 0;
    for (let page = 1; ; page++) {
      const { json, text } = await emagOrderRead(auth, { page, platform, createdAfter });
      if (!json || json.isError) {
        throw new Error(`eMAG ${platform.toUpperCase()} order/read: ${JSON.stringify(json?.messages || text.slice(0, 200))}`);
      }
      const orders = json.results || [];
      for (const o of orders) {
        if (viaBase.has(String(o.id))) {
          // Venită prin Base: liniile rămân, doar starea vine de la eMAG (Base nu știe de livrare).
          await query(
            `UPDATE emag_orders SET status = $2, updated_at = now() WHERE order_id = $1 AND status IS DISTINCT FROM $2`,
            [o.id, Number(o.status)]
          );
          skipped += 1;
          continue;
        }
        await saveOrder(o, { via: "sync", platform });
        saved += 1;
      }
      if (orders.length < ITEMS_PER_PAGE) break;
    }
    result[platform] = { saved, skipped };
  }
  return result;
}

/* ------------------------------ Trendyol ----------------------------- */

async function catalogIdFor(sku, barcode) {
  const { rows } = await query(
    `SELECT id FROM catalog_products
     WHERE ($1::text IS NOT NULL AND cod_produs = $1) OR ($2::text IS NOT NULL AND ean = $2)
     ORDER BY (cod_produs = $1) DESC NULLS LAST LIMIT 1`,
    [sku || null, barcode || null]
  );
  return rows[0]?.id ?? null;
}

/**
 * Salvează o linie Trendyol. Prin Base nu suprascrie o linie citită direct
 * (aceea e mai completă), doar îi ia anularea.
 */
async function saveTrendyolLine(line, via) {
  const catalogId = await catalogIdFor(line.sku, line.barcode);
  await query(
    `INSERT INTO trendyol_order_lines
       (line_id, order_number, package_id, status, order_date, sku, barcode, name, quantity, price,
        commission, currency, catalog_product_id, received_via, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (line_id) DO UPDATE SET
       status = CASE
         WHEN EXCLUDED.received_via = 'base' AND trendyol_order_lines.received_via <> 'base'
           THEN CASE WHEN EXCLUDED.status = 'Cancelled' THEN 'Cancelled' ELSE trendyol_order_lines.status END
         ELSE EXCLUDED.status END,
       order_number = CASE WHEN EXCLUDED.received_via = 'base' AND trendyol_order_lines.received_via <> 'base'
         THEN trendyol_order_lines.order_number ELSE EXCLUDED.order_number END,
       package_id = COALESCE(trendyol_order_lines.package_id, EXCLUDED.package_id),
       order_date = COALESCE(trendyol_order_lines.order_date, EXCLUDED.order_date),
       quantity = CASE WHEN EXCLUDED.received_via = 'base' AND trendyol_order_lines.received_via <> 'base'
         THEN trendyol_order_lines.quantity ELSE EXCLUDED.quantity END,
       price = CASE WHEN EXCLUDED.received_via = 'base' AND trendyol_order_lines.received_via <> 'base'
         THEN trendyol_order_lines.price ELSE EXCLUDED.price END,
       commission = COALESCE(EXCLUDED.commission, trendyol_order_lines.commission),
       catalog_product_id = COALESCE(EXCLUDED.catalog_product_id, trendyol_order_lines.catalog_product_id),
       received_via = CASE WHEN EXCLUDED.received_via = 'base' AND trendyol_order_lines.received_via <> 'base'
         THEN trendyol_order_lines.received_via ELSE EXCLUDED.received_via END,
       raw = CASE WHEN EXCLUDED.received_via = 'base' AND trendyol_order_lines.received_via <> 'base'
         THEN trendyol_order_lines.raw ELSE EXCLUDED.raw END,
       updated_at = now()`,
    [
      line.line_id,
      String(line.order_number),
      line.package_id ?? null,
      line.status || null,
      line.order_date,
      line.sku || null,
      line.barcode || null,
      line.name || "",
      toNum(line.quantity),
      toNum(line.price),
      toNum(line.commission),
      line.currency || "RON",
      catalogId,
      via,
      JSON.stringify(line.raw || {}),
    ]
  );
}

async function trendyolPage(creds, params) {
  const path = `/order/sellers/${creds.SUPPLIER_ID}/orders`;
  assertTrendyolReadOnly("GET", path);
  const url = new URL(`${TRENDYOL_API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.API_KEY}:${creds.API_SECRET}`).toString("base64")}`,
      "User-Agent": `${creds.SUPPLIER_ID} - SelfIntegration`,
      Accept: "application/json",
      storeFrontCode: String(process.env.TRENDYOL_STOREFRONT_CODE || "RO").toUpperCase(),
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Trendyol comenzi HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function importTrendyolHistory() {
  await ensureSchema();
  if (!(await isTrendyolConfigured())) return { saved: 0, packages: 0, note: "Trendyol neconfigurat" };
  const creds = await getTrendyolCreds();
  let end = Date.now();
  let packages = 0;
  let saved = 0;
  while (end > HISTORY_FROM.getTime()) {
    const start = Math.max(HISTORY_FROM.getTime(), end - 14 * DAY_MS);
    for (let page = 0; ; page++) {
      const data = await trendyolPage(creds, { startDate: start, endDate: end, page, size: 200 });
      for (const pkg of data.content || []) {
        packages += 1;
        for (const l of pkg.lines || []) {
          await saveTrendyolLine(
            {
              line_id: Number(l.lineId ?? l.id),
              order_number: pkg.orderNumber,
              package_id: pkg.shipmentPackageId ?? pkg.id,
              // Starea liniei (o linie poate fi anulată într-un colet livrat).
              status: l.orderLineItemStatusName || pkg.status,
              order_date: new Date(Number(pkg.orderDate)).toISOString(),
              sku: l.merchantSku || l.stockCode,
              barcode: l.barcode,
              name: l.productName,
              quantity: l.quantity,
              price: l.price ?? l.amount,
              commission: l.commission,
              currency: l.currencyCode || pkg.currencyCode,
              raw: { ...pkg, shipmentAddress: undefined, invoiceAddress: undefined },
            },
            "direct"
          );
          saved += 1;
        }
      }
      if (page >= (data.totalPages || 1) - 1) break;
    }
    end = start;
  }
  return { packages, saved };
}

/** Comandă Trendyol venită prin Base (status = codul eMAG din base-sync: 0 anulată, 4 trimisă). */
async function saveTrendyolFromBase(order, status) {
  const statusName = status === 0 ? "Cancelled" : status === 4 ? "Shipped" : "Created";
  let saved = 0;
  for (const p of order.products || []) {
    const lineId = Number(p.transaction_id) || -Number(p.order_product_id);
    if (!lineId) continue;
    await saveTrendyolLine(
      {
        line_id: lineId,
        order_number: order.external_order_id || `base-${order.order_id}`,
        package_id: null,
        status: statusName,
        order_date: new Date(Number(order.date_add) * 1000).toISOString(),
        sku: p.sku,
        barcode: p.ean,
        name: p.name,
        quantity: p.quantity,
        price: p.price_brutto,
        commission: null,
        currency: order.currency || "RON",
        raw: { base_order_id: order.order_id, ...p },
      },
      "base"
    );
    saved += 1;
  }
  return saved;
}

let running = null;
/** eMAG + Trendyol, tot istoricul. Un singur import odată. */
async function importAllHistory() {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const emag = await importEmagHistory();
    const trendyol = await importTrendyolHistory();
    const out = { emag, trendyol, ms: Date.now() - started, at: new Date().toISOString() };
    void log({
      level: "info",
      source: "orders",
      category: "history",
      message: `Istoric comenzi: eMAG RO ${emag.ro.saved}, HU ${emag.hu.saved}, BG ${emag.bg.saved}; Trendyol ${trendyol.saved} linii`,
      detail: out,
    });
    return out;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

module.exports = { importEmagHistory, importTrendyolHistory, importAllHistory, saveTrendyolFromBase };
