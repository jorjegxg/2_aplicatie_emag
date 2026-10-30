/**
 * Ce văd boții: catalogul local + Base + ofertele eMAG RO/HU/BG + Trendyol, legate pe produs.
 * Doar citire: getInventoryProductsData (Base), product_offer/read (eMAG), lista de produse Trendyol.
 * Instantaneul se ține în memorie câteva minute, ca boții și conversațiile să nu bată API-urile la fiecare întrebare.
 */
const { query } = require("../pg");
const base = require("../base-client");
const { createClient, validation, groupOf } = require("../emag-validari");
const emagChannel = require("../channels/emag");
const trendyol = require("../channels/trendyol");
const { isTrendyolConfigured } = require("../credentials-store");

const EMAG = ["ro", "hu", "bg"];
const TTL_MS = 10 * 60 * 1000;
const BASE_CHUNK = 100;
const TRENDYOL_MAX_PAGES = 20;

let cache = null;
let loading = null;

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const norm = (s) => String(s || "").trim().toLowerCase();

async function catalog() {
  const { rows } = await query(
    `SELECT c.id, c.cod_produs, c.nume, c.ean, c.brand, c.sale_price, c.general_stock, c.part_number_key,
            b.base_product_id, b.sku,
            (SELECT json_object_agg(t.lang, json_build_object('name', t.name, 'description', t.description))
               FROM product_texts t WHERE t.product_id = c.id) AS texte,
            (SELECT json_object_agg(v.platform, json_build_object('grp', v.grp, 'status', v.status, 'errors', v.errors))
               FROM emag_validation_state v WHERE v.product_id = c.id) AS validari
       FROM catalog_products c
       LEFT JOIN base_products b ON b.product_id = c.id
      ORDER BY c.id`
  );
  return rows;
}

/** Produsele din Base → Map(base_product_id → { pret, stoc, titluri{lang}, poze }). */
async function baseProducts(ids) {
  const out = new Map();
  if (!base.isConfigured()) return out;
  const cfg = base.config();
  for (let i = 0; i < ids.length; i += BASE_CHUNK) {
    const data = await base.getProductsData(ids.slice(i, i + BASE_CHUNK));
    for (const [id, p] of Object.entries(data)) {
      const tf = p.text_fields || {};
      const titluri = {};
      for (const [k, v] of Object.entries(tf)) {
        const m = /^name(?:\|([a-z]{2}))?$/.exec(k);
        if (m && v) titluri[m[1] || "ro"] = String(v);
      }
      const poze = Object.entries(p.images || {})
        .filter(([k, v]) => !String(k).includes("|") && v)
        .map(([, v]) => String(v));
      out.set(Number(id), {
        pret: num(p.prices?.[cfg.priceGroupId]),
        stoc: num(p.stock?.[cfg.warehouse]),
        ean: p.ean || null,
        sku: p.sku || null,
        titluri,
        poze,
      });
    }
  }
  return out;
}

function mapEmagOffer(raw) {
  const o = emagChannel.mapOffer(raw);
  const v = validation(raw);
  return {
    id: o.id,
    pnk: o.part_number_key || null,
    cod: o.part_number || null,
    titlu: o.name,
    pret: num(o.sale_price),
    moneda: o.currency,
    stoc: num(o.general_stock),
    activ: Number(o.status) === 1,
    poze: (o.images || []).map((im) => im.url),
    validare: { grp: groupOf(v), status: v.value, text: v.text, erori: v.errors },
  };
}

async function emagOffers() {
  const client = createClient();
  const out = {};
  const erori = {};
  for (const p of EMAG) {
    try {
      out[p] = (await client.readAllOffers(p)).map(mapEmagOffer);
    } catch (e) {
      erori[`emag_${p}`] = e.message;
      out[p] = null;
    }
  }
  return { out, erori };
}

async function trendyolListings() {
  if (!(await isTrendyolConfigured())) return { list: null, eroare: "Trendyol neconfigurat" };
  const list = [];
  try {
    for (let page = 1; page <= TRENDYOL_MAX_PAGES; page++) {
      const res = await trendyol.fetchListings({ page });
      list.push(...res.listings);
      if (!res.hasMore) break;
    }
  } catch (e) {
    return { list: list.length ? list : null, eroare: e.message };
  }
  return {
    list: list.map((l) => ({
      id: l.id,
      cod: l.part_number || null,
      ean: l.ean || null,
      titlu: l.name,
      pret: num(l.sale_price),
      moneda: l.currency,
      stoc: num(l.general_stock),
      activ: /aprobat|approved|vânzare|sale/i.test(String(l.approval_status || "")) || l.status === 1,
      aprobare: l.approval_status || null,
      respingeri: l.reject_reasons || [],
      poze: (l.images || []).map((im) => im.url || im).filter(Boolean),
      categorie: l.familie || null,
    })),
    eroare: null,
  };
}

function indexBy(list, keyFns) {
  const map = new Map();
  for (const item of list || []) {
    for (const fn of keyFns) {
      const k = norm(fn(item));
      if (k && !map.has(k)) map.set(k, item);
    }
  }
  return map;
}

async function load() {
  const t0 = Date.now();
  const produse = await catalog();
  const baseIds = produse.map((p) => Number(p.base_product_id)).filter(Boolean);
  const erori = {};
  const [baseMap, emag, ty] = await Promise.all([
    baseProducts(baseIds).catch((e) => {
      erori.base = e.message;
      return new Map();
    }),
    emagOffers(),
    trendyolListings(),
  ]);
  Object.assign(erori, emag.erori);
  if (ty.eroare) erori.trendyol = ty.eroare;

  const emagIdx = Object.fromEntries(
    EMAG.map((p) => [p, emag.out[p] ? indexBy(emag.out[p], [(o) => o.cod, (o) => o.pnk]) : null])
  );
  const tyIdx = ty.list ? indexBy(ty.list, [(l) => l.cod, (l) => l.ean]) : null;

  const rows = produse.map((p) => {
    const row = {
      id: p.id,
      cod: p.cod_produs,
      nume: p.nume,
      ean: p.ean,
      pnk: p.part_number_key,
      pret_catalog: num(p.sale_price),
      texte: p.texte || {},
      base: p.base_product_id ? baseMap.get(Number(p.base_product_id)) || { lipsa: true } : null,
      base_id: p.base_product_id ? Number(p.base_product_id) : null,
      emag: {},
      trendyol: null,
    };
    for (const pl of EMAG) {
      const idx = emagIdx[pl];
      row.emag[pl] = idx ? idx.get(norm(p.cod_produs)) || idx.get(norm(p.part_number_key)) || null : undefined;
    }
    if (tyIdx) row.trendyol = tyIdx.get(norm(p.cod_produs)) || tyIdx.get(norm(p.ean)) || null;
    else row.trendyol = undefined;
    return row;
  });

  return { la: new Date().toISOString(), durata_ms: Date.now() - t0, produse: rows, erori };
}

/** Instantaneul curent (cel mult TTL_MS vechi, sau proaspăt cu `fresh`). */
async function snapshot({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - new Date(cache.la).getTime() < TTL_MS) return cache;
  if (!loading) {
    loading = load()
      .then((s) => (cache = s))
      .finally(() => (loading = null));
  }
  return loading;
}

/** Caută produse după cod, nume, EAN, PNK → primele `limit` potriviri. */
async function findProducts(text, limit = 8) {
  const s = await snapshot();
  const q = norm(text);
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const scored = s.produse
    .map((p) => {
      const hay = norm([p.id, p.cod, p.nume, p.ean, p.pnk, p.texte?.ro?.name].join(" "));
      if (String(p.id) === q || norm(p.cod) === q || norm(p.pnk) === q || norm(p.ean) === q) return [p, 100];
      const hits = words.filter((w) => hay.includes(w)).length;
      return [p, hits / words.length];
    })
    .filter(([, sc]) => sc > 0.5)
    .sort((a, b) => b[1] - a[1]);
  return scored.slice(0, limit).map(([p]) => p);
}

module.exports = { EMAG, snapshot, findProducts };
