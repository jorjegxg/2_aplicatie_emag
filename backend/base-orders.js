/**
 * Comenzile citite din Base (BaseLinker) în locul citirii directe de la eMAG / Trendyol.
 * Pornește doar cu BASE_ORDERS=1; până atunci rămân pollerele directe (doar citire).
 *
 * Sursa comenzii decide canalul: `emagro` / `emaghu` / `emagbg` → eMAG pe platforma respectivă,
 * `trendyol` → Trendyol. Comanda e transformată în forma folosită deja de applyEmagOrder /
 * applyTrendyolPackage, deci stocul local, istoricul și notificările merg ca înainte.
 * Comenzile deja importate direct (înainte de Base) nu se ating, ca stocul să nu scadă de două ori.
 */
const { query } = require("./pg");
const base = require("./base-client");
const { applyEmagOrder } = require("./stock-movements");
const { applyTrendyolPackage } = require("./trendyol-orders");
const { log } = require("./logs-db");

const LOOKBACK_HOURS = Number(process.env.BASE_ORDER_LOOKBACK_HOURS ?? 72);
const CANCELED_NAME = /anulat|cancel|anulowan|storn/i;

function enabled() {
  return process.env.BASE_ORDERS === "1";
}

let statusCache = null;
/** Id-urile statusurilor Base care înseamnă „anulată” (după nume; statusurile sunt definite de tine în Base). */
async function canceledStatusIds() {
  if (statusCache) return statusCache;
  const data = await base.call("getOrderStatusList");
  statusCache = new Set(
    (data.statuses || []).filter((s) => CANCELED_NAME.test(String(s.name || ""))).map((s) => Number(s.id))
  );
  return statusCache;
}

function channelOf(order) {
  const src = String(order.order_source || "").toLowerCase();
  const m = src.match(/^emag(ro|hu|bg)$/);
  if (m) return { channel: "emag", platform: m[1] };
  if (src === "trendyol") return { channel: "trendyol" };
  return null;
}

/** Comanda există deja, importată direct de la marketplace (nu prin Base)? */
async function importedDirectly(orderId) {
  const { rows } = await query(
    `SELECT 1 FROM emag_orders WHERE order_id::text = $1 AND received_via <> 'base' LIMIT 1`,
    [String(orderId)]
  );
  return rows.length > 0;
}

function toEmagOrder(order, canceled) {
  const externalId = order.external_order_id || order.order_id;
  return {
    id: Number(externalId),
    status: canceled ? 0 : 1,
    date: new Date(Number(order.date_add) * 1000).toISOString().slice(0, 19).replace("T", " "),
    customer: { name: order.delivery_fullname || order.invoice_fullname || "" },
    payment_mode: order.payment_method || null,
    shipping_tax: order.delivery_price ?? null,
    channel: "emag",
    products: (order.products || []).map((p) => {
      const vat = (Number(p.tax_rate) || 0) / 100;
      return {
        id: `base-${order.order_id}-${p.order_product_id}`,
        product_id: null,
        sku: p.sku || null,
        part_number: p.sku || "",
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

function toTrendyolPackage(order, canceled) {
  return {
    id: order.order_id,
    orderNumber: String(order.external_order_id || order.order_id),
    status: canceled ? "Cancelled" : "Created",
    orderDate: Number(order.date_add) * 1000,
    lines: (order.products || []).map((p) => ({
      id: p.order_product_id,
      barcode: p.ean || null,
      merchantSku: p.sku || null,
      quantity: Number(p.quantity) || 0,
    })),
  };
}

async function applyBaseOrder(order) {
  const target = channelOf(order);
  if (!target) return null;
  const canceled = (await canceledStatusIds()).has(Number(order.order_status_id));
  if (target.channel === "trendyol") {
    return applyTrendyolPackage(toTrendyolPackage(order, canceled), { via: "base" });
  }
  const emagOrder = toEmagOrder(order, canceled);
  if (!Number.isFinite(emagOrder.id)) return null;
  if (await importedDirectly(emagOrder.id)) return null;
  return applyEmagOrder(emagOrder, { via: "base", platform: target.platform });
}

/** Comenzile din ultimele BASE_ORDER_LOOKBACK_HOURS ore (Base dă câte 100; paginăm după id). */
async function pollRecentBaseOrders() {
  const dateFrom = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600;
  let idFrom = 0;
  let processed = 0;
  for (;;) {
    const params = { date_from: dateFrom, get_unconfirmed_orders: true };
    if (idFrom) params.id_from = idFrom;
    const orders = await base.getOrders(params);
    for (const o of orders) {
      try {
        if (await applyBaseOrder(o)) processed += 1;
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
  return processed;
}

function startBaseOrderPoller() {
  const minutes = Number(process.env.BASE_ORDER_POLL_MINUTES ?? 5);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollRecentBaseOrders();
    } catch (err) {
      console.error("[base-order-poll]", err.message);
      void log({
        level: "error",
        source: "base",
        category: "orders",
        message: `Poll comenzi Base eșuat: ${err.message}`,
        detail: { stack: err.stack },
      });
    } finally {
      running = false;
    }
  };
  setInterval(tick, minutes * 60 * 1000);
  setTimeout(tick, 15 * 1000);
  console.log(`[base-order-poll] pornit la fiecare ${minutes} min`);
}

module.exports = { enabled, pollRecentBaseOrders, startBaseOrderPoller, applyBaseOrder };
