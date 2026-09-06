/**
 * Adaptor canal Trendyol — schelet. Nu face inca apeluri HTTP reale.
 *
 * Persistenta locala e doar pe eMAG (catalog_products + override-uri pe
 * marketplace_listings). Nu exista inca stocare pentru ofertele Trendyol, deci
 * apelurile de listings/diff pe acest canal raspund "Canal nesuportat"; maparea
 * de mai jos e doar pentru viitorul model de date.
 *
 * Mapare planificata (Trendyol Marketplace API, /sapigw/suppliers/{id}/products):
 *   barcode        -> id oferta
 *   stockCode      -> SKU (se leaga de catalog_products.cod_produs)
 *   productMainId  -> gruparea variantelor
 *   title          -> nume
 *   description    -> descriere
 *   salePrice      -> pret vanzare
 *   listPrice      -> pret recomandat
 *   quantity       -> stoc
 *   vatRate        -> TVA
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
