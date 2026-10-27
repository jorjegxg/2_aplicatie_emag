/**
 * Comisionul real eMAG și Trendyol, citit din comenzile din Base (doar citire).
 * Base dă comisionul pe comandă (`include_commission_data`); procentul = comision / valoarea
 * produselor cu TVA. Pe produs rămâne procentul din cea mai nouă comandă cu el, de preferat una
 * cu un singur produs (la comenzile cu mai multe produse procentul e o medie pe comandă).
 *
 * - eMAG RO (`emagro`) → marketplace_listings (emag, oferta produsului).procentaj_emag, ca
 *   înainte; HU/BG au alt comision și calculatorul e în lei, deci nu se folosesc.
 * - Trendyol (`trendyol`) → marketplace_listings (trendyol, SKU-ul produsului).procentaj_emag.
 *   Produsele fără comenzi Trendyol în Base iau comisionul din API-ul Trendyol (doar citire,
 *   `commission` pe variantă, fără TVA, la fel ca procentul eMAG).
 */
const { query } = require("./pg");
const base = require("./base-client");
const trendyol = require("./channels/trendyol");

const LOOKBACK_DAYS = 365;
const CHANNEL_BY_SOURCE = { emagro: "emag", trendyol: "trendyol" };

function orderPct(order) {
  const gross = Number(order.commission?.gross);
  const total = (order.products || []).reduce(
    (s, p) => s + (Number(p.price_brutto) || 0) * (Number(p.quantity) || 0),
    0
  );
  if (!(gross > 0) || !(total > 0)) return null;
  return Math.round((gross / total) * 10000) / 100;
}

/** Ce comandă dă procentul: cu un singur produs bate una cu mai multe, apoi cea mai nouă. */
function better(a, b) {
  if (!b) return true;
  if (a.single !== b.single) return a.single;
  return a.date > b.date;
}

/** channel → Map(sku → { pct, value, currency, order_id, date, single }) */
async function readFromBase({ days = LOOKBACK_DAYS } = {}) {
  const found = { emag: new Map(), trendyol: new Map() };
  const dateFrom = Math.floor(Date.now() / 1000) - days * 86400;
  let idFrom = 0;
  for (;;) {
    const params = { date_from: dateFrom, get_unconfirmed_orders: true, include_commission_data: true };
    if (idFrom) params.id_from = idFrom;
    const orders = await base.getOrders(params);
    for (const o of orders) {
      const channel = CHANNEL_BY_SOURCE[String(o.order_source || "").toLowerCase()];
      const pct = channel ? orderPct(o) : null;
      if (pct == null) continue;
      const skus = [...new Set((o.products || []).map((p) => p.sku).filter(Boolean))];
      for (const sku of skus) {
        const hit = {
          pct,
          value: Number(o.commission.gross),
          currency: o.commission.currency || o.currency || null,
          order_id: Number(o.order_id),
          date: Number(o.date_add) || 0,
          single: skus.length === 1,
        };
        if (better(hit, found[channel].get(sku))) found[channel].set(sku, hit);
      }
    }
    if (orders.length < 100) break;
    idFrom = Math.max(...orders.map((o) => Number(o.order_id))) + 1;
  }
  return found;
}

async function saveEmag(bySku, now) {
  if (!bySku.size) return [];
  const { rows: products } = await query(
    `SELECT id, cod_produs, emag_offer_id FROM catalog_products
     WHERE cod_produs = ANY($1::text[]) AND emag_offer_id IS NOT NULL`,
    [[...bySku.keys()]]
  );
  for (const p of products) {
    const hit = bySku.get(p.cod_produs);
    await query(
      `INSERT INTO marketplace_listings
         (channel, external_id, product_id, procentaj_emag, commission_value, commission_fetched_at, created_at, updated_at)
       VALUES ('emag', $1, $2, $3, $4, $5, $5, $5)
       ON CONFLICT (channel, external_id) DO UPDATE SET
         product_id = COALESCE(EXCLUDED.product_id, marketplace_listings.product_id),
         procentaj_emag = EXCLUDED.procentaj_emag,
         commission_value = EXCLUDED.commission_value,
         commission_fetched_at = EXCLUDED.commission_fetched_at,
         updated_at = EXCLUDED.updated_at`,
      [String(p.emag_offer_id), p.id, hit.pct, hit.value, now]
    );
  }
  return products.map((p) => p.cod_produs);
}

async function saveTrendyol(bySku, now) {
  if (!bySku.size) return [];
  const { rows: products } = await query(
    `SELECT id, cod_produs FROM catalog_products WHERE cod_produs = ANY($1::text[])`,
    [[...bySku.keys()]]
  );
  for (const p of products) {
    const hit = bySku.get(p.cod_produs);
    await query(
      `INSERT INTO marketplace_listings
         (channel, external_id, product_id, procentaj_emag, commission_value, commission_fetched_at, created_at, updated_at)
       VALUES ('trendyol', $1, $2, $3, $4, $5, $5, $5)
       ON CONFLICT (channel, external_id) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         procentaj_emag = EXCLUDED.procentaj_emag,
         commission_value = EXCLUDED.commission_value,
         commission_fetched_at = EXCLUDED.commission_fetched_at,
         updated_at = EXCLUDED.updated_at`,
      [p.cod_produs, p.id, hit.pct, hit.value, now]
    );
  }
  return products.map((p) => p.cod_produs);
}

/** SKU (stockCode) → { pct, ... } din ofertele Trendyol; Map gol dacă Trendyol nu răspunde. */
async function readTrendyolRates() {
  const found = new Map();
  try {
    for (let page = 1; ; page++) {
      const r = await trendyol.fetchListings({ page });
      for (const l of r.listings) {
        if (l.part_number && l.commission_rate != null && !found.has(l.part_number)) {
          found.set(l.part_number, { pct: l.commission_rate, value: null, order_id: null, date: 0, single: true });
        }
      }
      if (!r.hasMore) break;
    }
  } catch (err) {
    console.warn("[base-commission] Trendyol:", err.message);
  }
  return found;
}

/** Citește comisioanele din Base și le salvează; întoarce ce s-a actualizat, pe canal. */
async function refreshCommissions(opts) {
  const [found, tyRates] = await Promise.all([readFromBase(opts), readTrendyolRates()]);
  for (const [sku, hit] of tyRates) if (!found.trendyol.has(sku)) found.trendyol.set(sku, hit);
  const now = new Date().toISOString();
  const [emag, trendyol] = await Promise.all([saveEmag(found.emag, now), saveTrendyol(found.trendyol, now)]);
  const list = (channel, skus) =>
    skus.map((sku) => {
      const h = found[channel].get(sku);
      return { sku, pct: h.pct, order_id: h.order_id, date: h.date ? new Date(h.date * 1000).toISOString() : null };
    });
  return { emag: list("emag", emag), trendyol: list("trendyol", trendyol) };
}

/** Comisionul Trendyol salvat pentru produs (procent), sau null. */
async function getTrendyolPct(productId) {
  const { rows } = await query(
    `SELECT procentaj_emag FROM marketplace_listings
     WHERE channel = 'trendyol' AND product_id = $1 AND procentaj_emag IS NOT NULL
     ORDER BY commission_fetched_at DESC NULLS LAST LIMIT 1`,
    [Number(productId)]
  );
  return rows[0] ? Number(rows[0].procentaj_emag) : null;
}

module.exports = { refreshCommissions, getTrendyolPct };
