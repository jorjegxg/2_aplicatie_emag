/**
 * Trimiterea unui produs din aplicație în catalogul Base. De acolo Base îl publică pe
 * eMAG / Trendyol prin integrările lui; aplicația nu mai scrie direct pe marketplace-uri.
 *
 * Ce pleacă: SKU (cod_produs), EAN, greutate/dimensiuni, prețul de vânzare în lista de prețuri
 * Base, stocul în depozitul Base, titlul/descrierea pe fiecare limbă a catalogului
 * (`name`, `name|hu`, ...) și galeria RO (Base ține o singură galerie per produs).
 * Fără BASE_SEND=1 doar se construiește și se arată payload-ul.
 */
const crypto = require("crypto");
const { query } = require("./pg");
const pi = require("./product-images");
const { textToHtml } = require("./description-format");
const base = require("./base-client");

const LANGS = ["ro", "hu", "bg", "en"];
const MAX_IMAGES = 16;

async function loadProduct(productId) {
  const { rows } = await query(
    `SELECT id, cod_produs, ean, nume, descriere, sale_price, general_stock,
            greutate, inaltime, lungime, latime
     FROM catalog_products WHERE id = $1`,
    [Number(productId)]
  );
  if (!rows[0]) {
    const err = new Error(`Produsul ${productId} nu există`);
    err.status = 404;
    err.expected = true;
    throw err;
  }
  return rows[0];
}

/** Textele pe limbi: { ro: {name, description, characteristics}, hu: ..., ... }. RO cade pe catalog. */
async function getTexts(productId) {
  const product = await loadProduct(productId);
  const { rows } = await query(
    `SELECT lang, name, description, characteristics, updated_at FROM product_texts WHERE product_id = $1`,
    [Number(productId)]
  );
  const out = Object.fromEntries(LANGS.map((l) => [l, { name: null, description: null, characteristics: null }]));
  for (const r of rows) out[r.lang] = r;
  if (out.ro.name == null) out.ro.name = product.nume;
  if (out.ro.description == null) out.ro.description = product.descriere;
  return out;
}

/** Salvează textele unei limbi; pe RO ține și catalog_products.nume/descriere la fel. */
async function saveTexts(productId, lang, { name, description, characteristics }) {
  if (!LANGS.includes(lang)) {
    const err = new Error(`Limbă necunoscută: ${lang}`);
    err.status = 400;
    err.expected = true;
    throw err;
  }
  await loadProduct(productId);
  const clean = (v) => (v == null ? null : String(v).trim() || null);
  await query(
    `INSERT INTO product_texts (product_id, lang, name, description, characteristics, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (product_id, lang) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description,
       characteristics = EXCLUDED.characteristics, updated_at = now()`,
    [
      Number(productId),
      lang,
      clean(name),
      clean(description),
      characteristics == null ? null : JSON.stringify(characteristics),
    ]
  );
  if (lang === "ro") {
    await query(
      `UPDATE catalog_products SET nume = $2, descriere = $3, updated_at = now() WHERE id = $1`,
      [Number(productId), clean(name), clean(description)]
    );
  }
  return getTexts(productId);
}

async function getLink(productId) {
  const { rows } = await query(`SELECT * FROM base_products WHERE product_id = $1`, [Number(productId)]);
  return rows[0] || null;
}

function fingerprint(payload) {
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

/** Limbile catalogului Base, ținute 5 minute (implicit doar RO, cât timp nu se pot citi). */
let langsCache = null;
async function inventoryLangs() {
  if (langsCache && Date.now() - langsCache.at < 5 * 60_000) return langsCache.langs;
  try {
    const { inventory } = await base.getStatus();
    const langs = inventory?.languages?.length ? inventory.languages : ["ro"];
    langsCache = { at: Date.now(), langs };
    return langs;
  } catch (err) {
    console.warn("[base] limbile catalogului:", err.message);
    return ["ro"];
  }
}

/**
 * Ce ar pleca în Base pentru produs. `langs` = limbile catalogului Base; textele altor limbi
 * nu pot pleca până nu adaugi limba în catalog (Base respinge câmpurile `name|xx` necunoscute).
 */
async function buildPayload(productId, { langs } = {}) {
  const product = await loadProduct(productId);
  const texts = await getTexts(productId);
  const catalogLangs = langs || (await inventoryLangs());
  const defaultLang = catalogLangs[0] || "ro";
  const cfg = base.config();
  const warnings = [];

  const text_fields = {};
  for (const lang of LANGS) {
    const t = texts[lang];
    if (catalogLangs.includes(lang) && (!t?.name || !t?.description)) {
      warnings.push(`lipsește ${!t?.name && !t?.description ? "textul" : !t?.name ? "titlul" : "descrierea"} ${lang.toUpperCase()}`);
    }
    if (!t?.name && !t?.description) continue;
    if (!catalogLangs.includes(lang)) {
      warnings.push(`textele ${lang.toUpperCase()} nu pleacă: limba nu e în catalogul Base`);
      continue;
    }
    const suffix = lang === defaultLang ? "" : `|${lang}`;
    if (t.name) text_fields[`name${suffix}`] = t.name;
    if (t.description) text_fields[`description${suffix}`] = textToHtml(t.description);
    if (t.characteristics && typeof t.characteristics === "object") {
      text_fields[`features${suffix}`] = t.characteristics;
    }
  }

  const effective = await pi.effectiveImages(product.id, "ro");
  const gallery = effective.images.slice(0, MAX_IMAGES);
  if (effective.images.length > MAX_IMAGES) warnings.push(`Base primește doar ${MAX_IMAGES} poze`);
  if (!gallery.length) warnings.push("produsul nu are poze");
  let images = {};
  if (pi.IMAGES_PUBLIC) {
    images = Object.fromEntries(gallery.map((img, i) => [String(i), `url:${pi.absoluteUrl(img.stored_name)}`]));
  } else if (gallery.length) {
    warnings.push("pozele nu au link public (PUBLIC_IMAGE_BASE_URL) — nu pleacă");
  }

  if (!product.cod_produs) warnings.push("lipsește codul produsului (SKU)");
  if (product.sale_price == null) warnings.push("lipsește prețul de vânzare");

  const payload = {
    sku: product.cod_produs || "",
    ean: product.ean || "",
    weight: product.greutate != null ? Number(product.greutate) : 0,
    height: product.inaltime != null ? Number(product.inaltime) : 0,
    length: product.lungime != null ? Number(product.lungime) : 0,
    width: product.latime != null ? Number(product.latime) : 0,
    prices: product.sale_price != null ? { [cfg.priceGroupId]: Number(product.sale_price) } : {},
    stock: { [cfg.warehouse]: Math.max(0, Math.floor(Number(product.general_stock) || 0)) },
    text_fields,
    images,
  };
  const link = await getLink(productId);
  const fp = fingerprint(payload);
  return {
    product_id: product.id,
    payload,
    fingerprint: fp,
    changed: !link || link.last_push_fingerprint !== fp,
    link,
    image_source: effective.source,
    warnings,
    langs: catalogLangs,
  };
}

/** Produsul din Base: legătura salvată, apoi căutare după SKU, apoi după EAN. */
async function resolveBaseId(product, link) {
  if (link?.base_product_id) return Number(link.base_product_id);
  if (product.cod_produs) {
    const bySku = await base.findProducts({ sku: product.cod_produs });
    const exact = bySku.find((p) => String(p.sku) === String(product.cod_produs));
    if (exact) return exact.id;
  }
  if (product.ean) {
    const byEan = await base.findProducts({ ean: product.ean });
    if (byEan.length === 1) return byEan[0].id;
  }
  return null;
}

async function saveLink(productId, fields) {
  await query(
    `INSERT INTO base_products (product_id, base_product_id, sku, last_pushed_at, last_push_fingerprint, last_message, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (product_id) DO UPDATE SET
       base_product_id = COALESCE(EXCLUDED.base_product_id, base_products.base_product_id),
       sku = COALESCE(EXCLUDED.sku, base_products.sku),
       last_pushed_at = COALESCE(EXCLUDED.last_pushed_at, base_products.last_pushed_at),
       last_push_fingerprint = COALESCE(EXCLUDED.last_push_fingerprint, base_products.last_push_fingerprint),
       last_message = EXCLUDED.last_message,
       updated_at = now()`,
    [
      Number(productId),
      fields.base_product_id ?? null,
      fields.sku ?? null,
      fields.last_pushed_at ?? null,
      fields.last_push_fingerprint ?? null,
      fields.last_message ?? null,
    ]
  );
}

/**
 * Trimite produsul în Base. Fără BASE_SEND=1 întoarce doar payload-ul (`dry_run: true`).
 * @returns {{ dry_run: boolean, base_product_id?: number, created?: boolean, preview: object }}
 */
async function pushProductToBase(productId) {
  const preview = await buildPayload(productId);
  if (!base.sendEnabled()) return { dry_run: true, preview };

  const product = await loadProduct(productId);
  const existing = await resolveBaseId(product, preview.link);
  const body = existing ? { product_id: String(existing), ...preview.payload } : preview.payload;
  const baseId = await base.addInventoryProduct(body);
  await saveLink(productId, {
    base_product_id: baseId,
    sku: product.cod_produs,
    last_pushed_at: new Date(),
    last_push_fingerprint: preview.fingerprint,
    last_message: existing ? "actualizat în Base" : "creat în Base",
  });
  return { dry_run: false, base_product_id: baseId, created: !existing, preview };
}

/**
 * Doar preț și/sau stoc, pentru produsele deja legate în Base.
 * items: [{ product_id, price?, stock? }] → { sent, skipped: [product_id fără legătură] }
 */
async function pushPriceStock(items) {
  const ids = items.map((i) => Number(i.product_id));
  const { rows } = await query(
    `SELECT product_id, base_product_id FROM base_products WHERE product_id = ANY($1) AND base_product_id IS NOT NULL`,
    [ids]
  );
  const byId = new Map(rows.map((r) => [Number(r.product_id), Number(r.base_product_id)]));
  const linked = items.filter((i) => byId.has(Number(i.product_id)));
  const skipped = items.filter((i) => !byId.has(Number(i.product_id))).map((i) => Number(i.product_id));
  const prices = linked
    .filter((i) => i.price != null)
    .map((i) => ({ base_product_id: byId.get(Number(i.product_id)), price: i.price }));
  const stocks = linked
    .filter((i) => i.stock != null)
    .map((i) => ({ base_product_id: byId.get(Number(i.product_id)), stock: i.stock }));
  if (!base.sendEnabled()) return { dry_run: true, prices, stocks, skipped };
  if (prices.length) await base.updatePrices(prices);
  if (stocks.length) await base.updateStock(stocks);
  return { dry_run: false, sent: linked.length, skipped };
}

module.exports = {
  LANGS,
  getTexts,
  saveTexts,
  getLink,
  buildPayload,
  pushProductToBase,
  pushPriceStock,
};
