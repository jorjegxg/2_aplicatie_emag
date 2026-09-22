const { withTransaction, ensureSchema } = require("./pg");
const { toNum, stockSince, applyDelta, insertMovement } = require("./stock-movements");
const trendyol = require("./channels/trendyol");
const { log } = require("./logs-db");

const CHANNEL = "trendyol";
const SINCE_KEY = "trendyol_stock_orders_since";

// Statusuri pachet Trendyol (normalizate: lowercase, fara "_"). Webhook-ul le poate
// trimite ca "CANCELLED" / "AT_COLLECTION_POINT", API-ul ca "Cancelled" / "AtCollectionPoint".
const CANCELED = new Set(["cancelled", "unsupplied"]);
// Pachetul spart: liniile reapar in pachete noi, deci nu atingem stocul.
const IGNORED = new Set(["unpacked"]);

function normStatus(s) {
  return String(s || "").replace(/_/g, "").toLowerCase();
}

async function findCatalogProduct(client, line) {
  if (line.barcode) {
    const { rows } = await client.query(
      `SELECT id FROM catalog_products WHERE ean = $1 LIMIT 1`,
      [String(line.barcode)]
    );
    if (rows[0]) return rows[0].id;
  }
  if (line.merchantSku) {
    const { rows } = await client.query(
      `SELECT id FROM catalog_products WHERE part_number = $1 LIMIT 1`,
      [String(line.merchantSku)]
    );
    if (rows[0]) return rows[0].id;
  }
  return null;
}

/**
 * Liniile pachetului grupate pe barcode. Cheia de idempotenta e comanda + barcode
 * (nu id-ul pachetului), ca un pachet spart si recreat sa nu scada stocul de doua ori.
 */
function groupLines(pkg) {
  const pkgStatus = normStatus(pkg.status || pkg.shipmentPackageStatus);
  const byBarcode = new Map();
  for (const line of Array.isArray(pkg.lines) ? pkg.lines : []) {
    const key = String(line.barcode || line.merchantSku || line.id || "").trim();
    if (!key) continue;
    const status = normStatus(line.orderLineItemStatusName) || pkgStatus;
    const g = byBarcode.get(key) || { key, line, active: 0, canceled: false };
    if (CANCELED.has(status)) g.canceled = true;
    else g.active += toNum(line.quantity) || 0;
    byBarcode.set(key, g);
  }
  return { pkgStatus, groups: [...byBarcode.values()] };
}

/** Pachet Trendyol (webhook sau poll): scade stocul o singura data, restituie la anulare. */
async function applyTrendyolPackage(pkg, { via = "webhook" } = {}) {
  await ensureSchema();
  const orderId = String(pkg?.orderNumber ?? "").trim();
  if (!orderId) throw new Error("Pachet Trendyol fara orderNumber");
  const { pkgStatus, groups } = groupLines(pkg);
  const summary = { order_id: orderId, package_id: pkg.id, status: pkgStatus, deducted: [], restored: [], unmatched: [] };
  if (IGNORED.has(pkgStatus)) return summary;

  await withTransaction(async (client) => {
    const since = await stockSince(client, SINCE_KEY);
    const orderDate = toNum(pkg.orderDate);
    const isRecent = orderDate == null || orderDate >= new Date(since).getTime();

    for (const g of groups) {
      if (g.active > 0 && !g.canceled) {
        if (!isRecent) continue;
        const productId = await findCatalogProduct(client, g.line);
        const movementId = await insertMovement(client, {
          channel: CHANNEL,
          productId,
          orderId,
          lineId: g.key,
          offerId: null,
          kind: "order",
          delta: productId ? -g.active : 0,
          note: productId ? null : "produs negasit in catalog",
        });
        if (!movementId) continue; // deja procesata
        if (productId) {
          await applyDelta(client, movementId, productId, null, -g.active);
          summary.deducted.push({ barcode: g.key, product_id: productId, qty: g.active });
        } else {
          summary.unmatched.push({ barcode: g.key, sku: g.line.merchantSku || null });
        }
        continue;
      }
      if (!g.canceled) continue;

      // Anulare: restituim doar ce am scazut efectiv (stocul e limitat la 0).
      const { rows: prev } = await client.query(
        `SELECT product_id, stock_before, stock_after FROM stock_movements
         WHERE channel = $1 AND order_id = $2 AND line_id = $3 AND kind = 'order'`,
        [CHANNEL, orderId, g.key]
      );
      const deducted = prev[0];
      if (!deducted || !deducted.product_id) continue;
      const restoreQty = (toNum(deducted.stock_before) ?? 0) - (toNum(deducted.stock_after) ?? 0);
      if (restoreQty <= 0) continue;
      const movementId = await insertMovement(client, {
        channel: CHANNEL,
        productId: deducted.product_id,
        orderId,
        lineId: g.key,
        offerId: null,
        kind: "order-cancel",
        delta: restoreQty,
      });
      if (!movementId) continue;
      await applyDelta(client, movementId, deducted.product_id, null, restoreQty);
      summary.restored.push({ barcode: g.key, product_id: deducted.product_id, qty: restoreQty });
    }
  });

  if (summary.deducted.length || summary.restored.length || summary.unmatched.length) {
    void log({
      level: summary.unmatched.length ? "warn" : "info",
      source: "server",
      category: "webhook-trendyol",
      message:
        `[${via}] comanda Trendyol ${orderId}: scazut ${summary.deducted.length}, ` +
        `restituit ${summary.restored.length}, negasite ${summary.unmatched.length}`,
      detail: summary,
    });
  }
  return summary;
}

/** Poller de rezerva: pachetele din ultimele `lookbackMinutes` minute. */
async function pollRecentTrendyolOrders({ lookbackMinutes = 72 * 60 } = {}) {
  const endDate = Date.now();
  const startDate = endDate - lookbackMinutes * 60 * 1000;
  let processed = 0;
  for (let page = 0; ; page++) {
    const { content, totalPages } = await trendyol.fetchOrders({ startDate, endDate, page });
    for (const pkg of content) {
      await applyTrendyolPackage(pkg, { via: "poll" });
      processed += 1;
    }
    if (content.length < trendyol.ORDERS_PAGE_SIZE || page + 1 >= totalPages) break;
  }
  return processed;
}

module.exports = { applyTrendyolPackage, pollRecentTrendyolOrders };
