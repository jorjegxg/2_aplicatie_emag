/**
 * Client pentru API-ul Base (BaseLinker): https://api.baselinker.com/connector.php
 * Un singur endpoint; `method` + `parameters` (JSON) în corp, tokenul în header-ul X-BLToken.
 * Limita Base e 100 de cereri pe minut — aici ne oprim la BASE_MAX_PER_MINUTE (implicit 90).
 */
const { log, truncate } = require("./logs-db");

const BASE_API = "https://api.baselinker.com/connector.php";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_PER_MINUTE = Math.max(1, Number(process.env.BASE_MAX_PER_MINUTE) || 90);

const config = () => ({
  inventoryId: Number(process.env.BASE_INVENTORY_ID || 722),
  priceGroupId: Number(process.env.BASE_PRICE_GROUP_ID || 699),
  warehouse: String(process.env.BASE_WAREHOUSE || "bl_100786"),
});

/** BASE_SEND=1: scrierile pleacă pe bune; altfel doar se arată ce ar pleca. */
function sendEnabled() {
  return process.env.BASE_SEND === "1";
}

function isConfigured() {
  return Boolean(String(process.env.BASE_TOKEN || "").trim());
}

// Fereastră glisantă de 60 s pentru limita de cereri.
const recent = [];
async function throttle() {
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] > 60_000) recent.shift();
    if (recent.length < MAX_PER_MINUTE) {
      recent.push(now);
      return;
    }
    await new Promise((r) => setTimeout(r, 60_000 - (now - recent[0]) + 50));
  }
}

const WRITE_METHODS = /^(add|update|delete|set|run)/i;

async function call(method, parameters = {}) {
  const token = String(process.env.BASE_TOKEN || "").trim();
  if (!token) {
    const err = new Error("BASE_TOKEN lipsește din .env");
    err.status = 400;
    err.expected = true;
    throw err;
  }
  if (WRITE_METHODS.test(method) && !sendEnabled()) {
    const err = new Error(`Base: ${method} nu pleacă — BASE_SEND nu e 1`);
    err.status = 409;
    err.expected = true;
    throw err;
  }
  await throttle();
  const startedAt = Date.now();
  const body = new URLSearchParams({ method, parameters: JSON.stringify(parameters) });
  let text;
  let status = 0;
  try {
    const res = await fetch(BASE_API, {
      method: "POST",
      headers: { "X-BLToken": token },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch (cause) {
    void log({
      level: "error",
      source: "base",
      category: "http",
      message: `${method} — eroare rețea: ${cause.message}`,
      durationMs: Date.now() - startedAt,
    });
    const err = new Error(`Base: cerere eșuată — ${cause.message}`);
    err.status = 502;
    throw err;
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // tratat mai jos
  }
  const ok = status >= 200 && status < 300 && data?.status === "SUCCESS";
  void log({
    level: ok ? "debug" : "error",
    source: "base",
    category: "http",
    message: `${method} → ${ok ? "SUCCESS" : data?.error_code || `HTTP ${status}`}`,
    status,
    durationMs: Date.now() - startedAt,
    detail: {
      method,
      requestBody: truncate(JSON.stringify(parameters), 3000),
      responseBody: truncate(text, 4000),
    },
  });
  if (!ok) {
    const err = new Error(
      `Base ${method}: ${data?.error_message || data?.error_code || `răspuns invalid (HTTP ${status})`}`
    );
    err.status = 502;
    err.code = data?.error_code;
    throw err;
  }
  return data;
}

/** Produsele din catalog care au SKU-ul sau EAN-ul dat → [{ id, sku, ean, name }]. */
async function findProducts({ sku, ean } = {}) {
  const parameters = { inventory_id: config().inventoryId };
  if (sku) parameters.filter_sku = String(sku);
  else if (ean) parameters.filter_ean = String(ean);
  else return [];
  const data = await call("getInventoryProductsList", parameters);
  return Object.entries(data.products || {}).map(([id, p]) => ({ id: Number(id), ...p }));
}

async function getProductsData(productIds) {
  if (!productIds.length) return {};
  const data = await call("getInventoryProductsData", {
    inventory_id: config().inventoryId,
    products: productIds.map(Number),
  });
  return data.products || {};
}

/** Creează sau actualizează (cu `product_id`) un produs din catalog → id-ul lui în Base. */
async function addInventoryProduct(product) {
  const data = await call("addInventoryProduct", { inventory_id: config().inventoryId, ...product });
  return Number(data.product_id);
}

/** Id-ul producătorului din Base după nume; îl creează dacă lipsește (doar cu BASE_SEND=1). */
const manufacturerIds = new Map();
async function ensureManufacturer(name) {
  const key = String(name || "").trim();
  if (!key) return 0;
  if (manufacturerIds.has(key.toLowerCase())) return manufacturerIds.get(key.toLowerCase());
  const data = await call("getInventoryManufacturers");
  for (const m of data.manufacturers || []) {
    manufacturerIds.set(String(m.name).trim().toLowerCase(), Number(m.manufacturer_id));
  }
  if (!manufacturerIds.has(key.toLowerCase()) && sendEnabled()) {
    const added = await call("addInventoryManufacturer", { name: key });
    manufacturerIds.set(key.toLowerCase(), Number(added.manufacturer_id));
  }
  return manufacturerIds.get(key.toLowerCase()) || 0;
}

/** items: [{ base_product_id, price }] — lista de prețuri BASE_PRICE_GROUP_ID. */
async function updatePrices(items) {
  const { inventoryId, priceGroupId } = config();
  const products = Object.fromEntries(
    items.map((i) => [String(i.base_product_id), { [priceGroupId]: Number(i.price) }])
  );
  return call("updateInventoryProductsPrices", { inventory_id: inventoryId, products });
}

/** items: [{ base_product_id, stock }] — depozitul BASE_WAREHOUSE. */
async function updateStock(items) {
  const { inventoryId, warehouse } = config();
  const products = Object.fromEntries(
    items.map((i) => [String(i.base_product_id), { [warehouse]: Number(i.stock) }])
  );
  return call("updateInventoryProductsStock", { inventory_id: inventoryId, products });
}

/** Catalogul, limbile lui și integrările (eMAG RO, Trendyol, ...) conectate în Base. */
async function getStatus() {
  const { inventoryId } = config();
  const [inv, integ] = await Promise.all([
    call("getInventories"),
    call("getInventoryIntegrations", { inventory_id: inventoryId }),
  ]);
  const inventory = (inv.inventories || []).find((i) => Number(i.inventory_id) === inventoryId) || null;
  const integrations = Object.entries(integ.integrations || {}).flatMap(([code, v]) =>
    Object.entries(v.accounts || {}).map(([accountId, name]) => ({
      code,
      account_id: Number(accountId),
      name,
      langs: v.langs || [],
    }))
  );
  return { inventory, integrations, config: config(), send_enabled: sendEnabled() };
}

/** Jurnalul de evenimente (comenzi noi, anulări) după `last_log_id`. */
async function getJournalList(lastLogId, logsTypes) {
  const data = await call("getJournalList", { last_log_id: Number(lastLogId) || 0, logs_types: logsTypes });
  return data.logs || [];
}

async function getOrders(parameters) {
  const data = await call("getOrders", parameters);
  return data.orders || [];
}

async function getOrderSources() {
  const data = await call("getOrderSources");
  return data.sources || {};
}

module.exports = {
  call,
  config,
  sendEnabled,
  isConfigured,
  findProducts,
  getProductsData,
  addInventoryProduct,
  ensureManufacturer,
  updatePrices,
  updateStock,
  getStatus,
  getJournalList,
  getOrders,
  getOrderSources,
};
