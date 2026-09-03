/**
 * Adaptor canal Trendyol — schelet. Nu face inca apeluri HTTP reale.
 *
 * Mapare planificata (Trendyol Marketplace API, /sapigw/suppliers/{id}/products):
 *   barcode        -> external_id      (ID-ul ofertei la Trendyol)
 *   stockCode      -> part_number      (SKU-ul meu; se leaga de catalog_products.cod_produs)
 *   productMainId  -> part_number_key  (gruparea variantelor)
 *   title          -> name
 *   description    -> description
 *   salePrice      -> sale_price
 *   listPrice      -> recommended_price
 *   quantity       -> general_stock / stock[0].value
 *   vatRate        -> vat_id
 *   brand          -> brand
 *   approved       -> status (1 = activ)
 * Update pret/stoc: POST /sapigw/suppliers/{id}/products/price-and-inventory
 *   { items: [{ barcode, quantity, salePrice, listPrice }] }
 * Auth: Basic base64(apiKey:apiSecret) + header `x-agentname`.
 * Credentiale: credentials.json -> { "trendyol": { "SUPPLIER_ID", "API_KEY", "API_SECRET" } }
 */

const id = "trendyol";
const label = "Trendyol";

const NOT_CONFIGURED = "Trendyol neconfigurat — adaugă secțiunea trendyol în credentials.json";

function notConfigured() {
  const err = new Error(NOT_CONFIGURED);
  err.status = 501;
  throw err;
}

async function fetchListings() {
  return notConfigured();
}

async function pushListings() {
  return notConfigured();
}

function buildPushPayload() {
  return notConfigured();
}

async function fetchCommission() {
  return notConfigured();
}

async function resolveCommissionAuth() {
  return notConfigured();
}

module.exports = {
  id,
  label,
  configured: false,
  fetchListings,
  pushListings,
  buildPushPayload,
  fetchCommission,
  resolveCommissionAuth,
};
