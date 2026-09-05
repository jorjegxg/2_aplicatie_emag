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
 * Credentiale: Setări → Trendyol (SUPPLIER_ID, API_KEY, API_SECRET) în DB criptat
 */

const {
  isTrendyolConfigured,
  credentialsMissingError,
  getTrendyolCreds,
} = require("../credentials-store");

const id = "trendyol";
const label = "Trendyol";

async function requireConfigured() {
  if (!(await isTrendyolConfigured())) {
    throw credentialsMissingError(
      "trendyol",
      "Credentiale Trendyol lipsă. Mergi la Setări (sus-dreapta) și setează Supplier ID, API Key și API Secret."
    );
  }
  return getTrendyolCreds();
}

async function fetchListings() {
  await requireConfigured();
  const err = new Error("Trendyol: sync-ul nu e implementat încă");
  err.status = 501;
  throw err;
}

async function pushListings() {
  await requireConfigured();
  const err = new Error("Trendyol: publicarea nu e implementată încă");
  err.status = 501;
  throw err;
}

function buildPushPayload() {
  const err = new Error("Trendyol: publicarea nu e implementată încă");
  err.status = 501;
  throw err;
}

async function fetchCommission() {
  await requireConfigured();
  const err = new Error("Trendyol: comisionul nu e implementat încă");
  err.status = 501;
  throw err;
}

async function resolveCommissionAuth() {
  await requireConfigured();
  const err = new Error("Trendyol: comisionul nu e implementat încă");
  err.status = 501;
  throw err;
}

module.exports = {
  id,
  label,
  fetchListings,
  pushListings,
  buildPushPayload,
  fetchCommission,
  resolveCommissionAuth,
};
