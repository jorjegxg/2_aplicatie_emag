/**
 * Stratul multi-canal peste Postgres.
 *
 * catalog_products      — SoT local eMAG (preturi, identitate, pret_cumparare); nu se umple din pull
 * marketplace_listings  — override-uri locale eMAG (costuri, comision, pret_minim)
 * channel-remote-cache  — oglinda remote a canalului (TTL memorie; pull + push status/vat/handling)
 */
const { query, withTransaction, ensureSchema: ensurePgSchema } = require("./pg");
const { getLastPriceChangeBulk } = require("./db");
const { calcProduct } = require("./calculator");
const { htmlToText, looksLikeHtml } = require("./description-format");
const {
  listByPlatformForProductIds,
  FALLBACK_PLATFORM,
} = require("./product-images");
const {
  getChannelRemotes,
  getCacheMeta,
  setChannelRemotes,
  upsertChannelRemote,
  clearChannelCache,
} = require("./channel-remote-cache");

const CHANNELS = ["emag", "trendyol"];

function normalizeChannel(channel) {
  const c = String(channel || "emag").trim().toLowerCase();
  return CHANNELS.includes(c) ? c : "emag";
}

/** Persistenta e doar pe eMAG (catalog SoT + override-uri locale). */
function assertEmagSot(channel) {
  const ch = normalizeChannel(channel);
  if (ch !== "emag") throw new Error(`Canal nesuportat: ${ch}`);
  return ch;
}

function toNumOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toTextOrNull(v) {
  if (v == null) return null;
  const s = String(v);
  return s === "" ? null : s;
}

function toMoneda(v) {
  return String(v || "").trim().toUpperCase() === "RMB" ? "RMB" : "USD";
}

function toIntOrNull(v) {
  const n = toNumOrNull(v);
  return n == null ? null : Math.max(0, Math.round(n));
}

function toPlainTextOrNull(v) {
  if (v == null) return null;
  const s = looksLikeHtml(v) ? htmlToText(v) : String(v);
  return s === "" ? null : s;
}

/** Upsert familie in lookup; pe conflict actualizeaza name (SoT). */
async function ensureProductFamily(idFamilie, familie, client) {
  const id = toNumOrNull(idFamilie);
  const name = toTextOrNull(familie);
  if (id == null || name == null) return;
  const q = client ? client.query.bind(client) : query;
  await q(
    `INSERT INTO product_families (id, name) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [id, name]
  );
}

/** Comision pe listings (nu pe catalog). */
const LISTING_COST_FIELDS = [
  "procentaj_emag",
  "commission_value",
  "commission_fetched_at",
];

/** Catalog + familie + override-uri locale din marketplace_listings (eMAG). */
const SQL_CATALOG_WITH_FAMILIE = `
  SELECT c.*, pf.name AS familie,
         ml.pret_minim_override,
         ml.procentaj_emag,
         ml.commission_value,
         ml.commission_fetched_at,
         (
           SELECT COUNT(DISTINCT olh.order_id)
           FROM order_line_history olh
           WHERE olh.product_id = c.id
         ) AS order_count
  FROM catalog_products c
  LEFT JOIN product_families pf ON pf.id = c.id_familie
  LEFT JOIN marketplace_listings ml
    ON ml.channel = 'emag' AND ml.external_id = c.emag_offer_id
`;

/** Upsert campuri pe marketplace_listings canal eMAG. */
async function upsertEmagListingFields(productId, externalId, fieldPayload, now) {
  const keys = Object.keys(fieldPayload || {});
  if (keys.length === 0) return;
  const cols = ["channel", "external_id", "product_id", ...keys, "created_at", "updated_at"];
  const params = [
    "emag",
    String(externalId),
    productId,
    ...keys.map((k) => fieldPayload[k]),
    now,
    now,
  ];
  const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
  const conflictSets = [
    "product_id = COALESCE(EXCLUDED.product_id, marketplace_listings.product_id)",
    ...keys.map((k) => `${k} = EXCLUDED.${k}`),
    "updated_at = EXCLUDED.updated_at",
  ];
  await query(
    `INSERT INTO marketplace_listings (${cols.join(", ")})
     VALUES (${placeholders})
     ON CONFLICT (channel, external_id) DO UPDATE SET ${conflictSets.join(", ")}`,
    params
  );
}

/** Shape compatibil cu vechiul marketplace_listings (server sync-prices etc.). */
function catalogToListingShape(row, { channel = "emag", externalId } = {}) {
  if (!row) return null;
  const ch = normalizeChannel(channel);
  return {
    ...row,
    channel: ch,
    external_id:
      externalId != null
        ? String(externalId)
        : ch === "trendyol"
          ? normalizeEan(row.ean) || row.ean
          : row.emag_offer_id,
    name: row.nume,
    description: row.descriere,
    product_id: row.id,
  };
}

async function ensureSchema() {
  await ensurePgSchema();
}

/**
 * EAN comparabil: trim, lower, primul segment daca e lista separata prin virgula
 * (format eMAG pe catalog).
 */
function normalizeEan(v) {
  const s = toTextOrNull(v);
  if (!s) return null;
  const first = s.split(",")[0].trim().toLowerCase();
  return first || null;
}

/** Ataseaza pozele pe produse: `images` = setul EN (compat), `images_by_platform` = toate seturile. */
async function attachImages(products) {
  const imageMap = await listByPlatformForProductIds(
    products.map((p) => p.product_id).filter((id) => id != null)
  );
  for (const p of products) {
    const pid = Number(p.product_id);
    const byPlatform = Number.isFinite(pid) ? imageMap.get(pid) : null;
    p.images_by_platform = byPlatform || { en: [], ro: [], bg: [], hu: [] };
    p.images = p.images_by_platform[FALLBACK_PLATFORM] || [];
  }
}

const CHANNEL_LABELS = { emag: "eMAG", trendyol: "Trendyol" };

/**
 * `promotions` pe fiecare produs: eMAG dupa id-ul ofertei, Trendyol dupa EAN (= barcode).
 * -> [{ channel, label, name, promo_price, sale_price, seen_at }]
 */
async function attachPromotions(products) {
  const { rows } = await query(
    `SELECT channel, external_id, name, promo_price, sale_price, seen_at FROM channel_promotions`
  );
  const byKey = new Map();
  for (const r of rows) {
    const key =
      r.channel === "trendyol" ? `trendyol:${normalizeEan(r.external_id)}` : `${r.channel}:${r.external_id}`;
    byKey.set(key, {
      channel: r.channel,
      label: CHANNEL_LABELS[r.channel] || r.channel,
      name: r.name,
      promo_price: toNumOrNull(r.promo_price),
      sale_price: toNumOrNull(r.sale_price),
      seen_at: r.seen_at instanceof Date ? r.seen_at.toISOString() : r.seen_at,
    });
  }
  for (const p of products) {
    const ean = normalizeEan(p.ean);
    p.promotions = [byKey.get(`emag:${p.id}`), ean ? byKey.get(`trendyol:${ean}`) : null].filter(
      Boolean
    );
  }
}

function mapCatalogRowToProduct(r) {
  return {
    id: Number(r.emag_offer_id) || r.emag_offer_id,
    channel: "emag",
    product_id: r.id,
    name: r.nume || "",
    description: r.descriere || "",
    brand: r.brand || "",
    part_number: r.part_number || r.cod_produs || "",
    part_number_key: r.part_number_key || "",
    id_familie: r.id_familie ?? null,
    familie: r.familie || "",
    sale_price: toNumOrNull(r.sale_price),
    recommended_price: toNumOrNull(r.recommended_price),
    min_sale_price: toNumOrNull(r.min_sale_price),
    max_sale_price: toNumOrNull(r.max_sale_price),
    pret_cumparare: toNumOrNull(r.pret_cumparare),
    pret_cumparare_usd: toNumOrNull(r.pret_cumparare_usd),
    order_count: Number(r.order_count) || 0,
    link_cumparare: toTextOrNull(r.link_cumparare) || "",
    moneda_fabrica: toMoneda(r.moneda_fabrica),
    nr_bucati: toNumOrNull(r.nr_bucati),
    link_ali: toTextOrNull(r.link_ali) || "",
    link_amz: toTextOrNull(r.link_amz) || "",
    ce: toTextOrNull(r.ce) || "",
    decizie: toTextOrNull(r.decizie) || "",
    transport_override: toNumOrNull(r.transport_override),
    greutate: toNumOrNull(r.greutate),
    inaltime: toNumOrNull(r.inaltime),
    lungime: toNumOrNull(r.lungime),
    latime: toNumOrNull(r.latime),
    pret_minim_override: toNumOrNull(r.pret_minim_override),
    procentaj_emag: toNumOrNull(r.procentaj_emag),
    commission_value: toNumOrNull(r.commission_value),
    commission_fetched_at:
      r.commission_fetched_at instanceof Date
        ? r.commission_fetched_at.toISOString()
        : r.commission_fetched_at ?? null,
    currency: r.currency || "RON",
    general_stock: toNumOrNull(r.general_stock),
    estimated_stock: null,
    status: null,
    vat_id: null,
    handling_time: [{ warehouse_id: 1, value: 0 }],
    stock: [{ warehouse_id: 1, value: Number(r.general_stock) || 0 }],
    ean: r.ean || "",
    characteristics: "",
    images: [],
  };
}

async function getCatalogRows(channel) {
  await ensureSchema();
  assertEmagSot(channel);

  const { rows } = await query(
    `${SQL_CATALOG_WITH_FAMILIE}
     WHERE c.emag_offer_id IS NOT NULL
     ORDER BY CAST(NULLIF(c.emag_offer_id, '') AS BIGINT) ASC NULLS LAST`
  );
  const products = rows.map(mapCatalogRowToProduct);

  const lastChanges = await getLastPriceChangeBulk(products.map((p) => p.id));
  for (const p of products) {
    const lc = lastChanges[p.id];
    p.pret_emag_last_change = lc ? lc.recorded_at : null;
  }

  await attachImages(products);
  await attachPromotions(products);
  return products;
}

const LISTING_EDITABLE = {
  name: toTextOrNull,
  description: toPlainTextOrNull,
  sale_price: toNumOrNull,
  recommended_price: toNumOrNull,
  min_sale_price: toNumOrNull,
  max_sale_price: toNumOrNull,
  general_stock: toNumOrNull,
  transport_override: toNumOrNull,
  greutate: toNumOrNull,
  inaltime: toNumOrNull,
  lungime: toNumOrNull,
  latime: toNumOrNull,
  pret_cumparare_usd: toNumOrNull,
  link_cumparare: toTextOrNull,
  moneda_fabrica: toMoneda,
  nr_bucati: toIntOrNull,
  link_ali: toTextOrNull,
  link_amz: toTextOrNull,
  ce: toTextOrNull,
  decizie: toTextOrNull,
  pret_minim_override: toNumOrNull,
  procentaj_emag: toNumOrNull,
  commission_value: toNumOrNull,
  commission_fetched_at: (v) => {
    if (v == null || v === "") return null;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  },
  status: toNumOrNull,
  vat_id: toNumOrNull,
};

/** Map API field names → catalog columns (comisionul si pret_minim raman pe listings). */
const LISTING_TO_CATALOG_COL = {
  name: "nume",
  description: "descriere",
  sale_price: "sale_price",
  recommended_price: "recommended_price",
  min_sale_price: "min_sale_price",
  max_sale_price: "max_sale_price",
  general_stock: "general_stock",
  transport_override: "transport_override",
  greutate: "greutate",
  inaltime: "inaltime",
  lungime: "lungime",
  latime: "latime",
  pret_cumparare_usd: "pret_cumparare_usd",
  link_cumparare: "link_cumparare",
  moneda_fabrica: "moneda_fabrica",
  nr_bucati: "nr_bucati",
  link_ali: "link_ali",
  link_amz: "link_amz",
  ce: "ce",
  decizie: "decizie",
};

/** Campurile din care se calculeaza pret_cumparare (costul final din calculator). */
const PRET_CUMPARARE_INPUTS = [
  "pret_cumparare_usd",
  "moneda_fabrica",
  "greutate",
  "inaltime",
  "lungime",
  "latime",
];

function touchesPretCumparareInputs(fields) {
  return PRET_CUMPARARE_INPUTS.some((k) =>
    Object.prototype.hasOwnProperty.call(fields || {}, k)
  );
}

/**
 * Recalculeaza catalog_products.pret_cumparare = costul final din calculator (ruta din parametri).
 * productIds null = toate produsele. Produsele fara pret fabrica / greutate raman neschimbate.
 */
async function recalcPretCumparare(productIds = null, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows: settingsRows } = await q(
    "SELECT calculator_params FROM settings WHERE id = 1"
  );
  const params = settingsRows[0]?.calculator_params || null;
  const ids = productIds == null ? null : productIds.map(Number).filter(Number.isFinite);
  if (ids && ids.length === 0) return 0;

  const { rows } = await q(
    `SELECT id, pret_cumparare, pret_cumparare_usd, moneda_fabrica,
            greutate, inaltime, lungime, latime
     FROM catalog_products
     ${ids ? "WHERE id = ANY($1::int[])" : ""}`,
    ids ? [ids] : []
  );

  let updated = 0;
  for (const r of rows) {
    const out = calcProduct(
      {
        pret_fabrica: r.pret_cumparare_usd,
        moneda: r.moneda_fabrica,
        greutate: r.greutate,
        inaltime: r.inaltime,
        lungime: r.lungime,
        latime: r.latime,
      },
      params
    );
    if (!out || !Number.isFinite(out.pret_cumparare)) continue;
    const next = Math.round(out.pret_cumparare * 10000) / 10000;
    const prev = toNumOrNull(r.pret_cumparare);
    if (prev != null && Math.abs(prev - next) < 0.00005) continue;
    await q("UPDATE catalog_products SET pret_cumparare = $1 WHERE id = $2", [next, r.id]);
    updated++;
  }
  return updated;
}

async function setListingPretCumparare(channel, externalId, value) {
  await ensureSchema();
  assertEmagSot(channel);
  const price = toNumOrNull(value);
  const now = new Date().toISOString();

  const listing = await getListing(channel, externalId);
  if (!listing) throw new Error("Listing inexistent");
  await query(
    "UPDATE catalog_products SET pret_cumparare = $1, updated_at = $2 WHERE id = $3",
    [price, now, listing.product_id]
  );
  return listing.product_id;
}

async function updateListingEmag(externalId, fields) {
  const ext = String(externalId ?? "").trim();
  if (!ext) throw new Error("external_id invalid");
  const now = new Date().toISOString();

  const { rows: existing } = await query(
    "SELECT id FROM catalog_products WHERE emag_offer_id = $1 LIMIT 1",
    [ext]
  );
  let productId = existing[0]?.id ?? null;
  if (productId == null) {
    const { rows: inserted } = await query(
      `INSERT INTO catalog_products (emag_offer_id, created_at, updated_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [ext, now, now]
    );
    productId = inserted[0].id;
  }

  if (Object.prototype.hasOwnProperty.call(fields, "pret_cumparare")) {
    await setListingPretCumparare("emag", ext, fields.pret_cumparare);
  }

  const catalogPayload = {};
  for (const [key, coerce] of Object.entries(LISTING_EDITABLE)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    if (LISTING_COST_FIELDS.includes(key)) continue;
    if (key === "status" || key === "vat_id" || key === "pret_minim_override") continue;
    const col = LISTING_TO_CATALOG_COL[key];
    if (col) catalogPayload[col] = coerce(fields[key]);
  }
  if (Array.isArray(fields.stock)) {
    catalogPayload.general_stock = fields.stock.reduce(
      (sum, s) => sum + (Number(s?.value) || 0),
      0
    );
  }

  const catalogKeys = Object.keys(catalogPayload);
  if (catalogKeys.length > 0) {
    const params = [];
    const sets = catalogKeys.map((k) => {
      params.push(catalogPayload[k]);
      return `${k} = $${params.length}`;
    });
    params.push(now, ext);
    await query(
      `UPDATE catalog_products SET ${sets.join(", ")}, updated_at = $${params.length - 1}
       WHERE emag_offer_id = $${params.length}`,
      params
    );
  }

  const listingPayload = {};
  for (const key of LISTING_COST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      listingPayload[key] = LISTING_EDITABLE[key](fields[key]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(fields, "pret_minim_override")) {
    listingPayload.pret_minim_override = toNumOrNull(fields.pret_minim_override);
  }

  await upsertEmagListingFields(productId, ext, listingPayload, now);

  if (touchesPretCumparareInputs(fields)) {
    await recalcPretCumparare([productId]);
  }

  return getListing("emag", ext);
}

async function updateListing(channel, externalId, fields) {
  await ensureSchema();
  assertEmagSot(channel);
  return updateListingEmag(externalId, fields);
}

async function getListing(channel, externalId) {
  await ensureSchema();
  assertEmagSot(channel);
  const ext = String(externalId);
  const { rows } = await query(
    `${SQL_CATALOG_WITH_FAMILIE} WHERE c.emag_offer_id = $1 LIMIT 1`,
    [ext]
  );
  return catalogToListingShape(rows[0] || null);
}

const PRODUCT_EDITABLE = {
  cod_produs: toTextOrNull,
  nume: toTextOrNull,
  descriere: toPlainTextOrNull,
  brand: toTextOrNull,
  ean: toTextOrNull,
  pret_cumparare: toNumOrNull,
  pret_cumparare_usd: toNumOrNull,
  link_cumparare: toTextOrNull,
  moneda_fabrica: toMoneda,
  nr_bucati: toIntOrNull,
  link_ali: toTextOrNull,
  link_amz: toTextOrNull,
  ce: toTextOrNull,
  decizie: toTextOrNull,
  emag_offer_id: toTextOrNull,
  part_number: toTextOrNull,
  part_number_key: toTextOrNull,
  id_familie: toNumOrNull,
  sale_price: toNumOrNull,
  recommended_price: toNumOrNull,
  min_sale_price: toNumOrNull,
  max_sale_price: toNumOrNull,
  general_stock: toNumOrNull,
  currency: toTextOrNull,
  transport_override: toNumOrNull,
  greutate: toNumOrNull,
  inaltime: toNumOrNull,
  lungime: toNumOrNull,
  latime: toNumOrNull,
};

const PRODUCT_LISTING_EDITABLE = {
  pret_minim_override: toNumOrNull,
};

/** emag_offer_id al unui produs din catalog, sau null. */
async function getProductOfferId(productId) {
  await ensureSchema();
  const id = Number(productId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const { rows } = await query(
    "SELECT emag_offer_id FROM catalog_products WHERE id = $1",
    [id]
  );
  const ext = rows[0]?.emag_offer_id;
  return ext == null || String(ext).trim() === "" ? null : String(ext).trim();
}

async function updateProduct(productId, fields) {
  await ensureSchema();
  const id = Number(productId);
  if (!Number.isFinite(id)) throw new Error("product_id invalid");

  const payload = {};
  for (const [key, coerce] of Object.entries(PRODUCT_EDITABLE)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      payload[key] = coerce(fields[key]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(fields, "name") && payload.nume === undefined) {
    payload.nume = toTextOrNull(fields.name);
  }
  if (
    Object.prototype.hasOwnProperty.call(fields, "description") &&
    payload.descriere === undefined
  ) {
    payload.descriere = toPlainTextOrNull(fields.description);
  }
  if (Array.isArray(fields.stock)) {
    payload.general_stock = fields.stock.reduce(
      (sum, s) => sum + (Number(s?.value) || 0),
      0
    );
  }

  if (Object.prototype.hasOwnProperty.call(payload, "id_familie")) {
    const name = Object.prototype.hasOwnProperty.call(fields, "familie")
      ? toTextOrNull(fields.familie)
      : null;
    if (payload.id_familie != null && name != null) {
      await ensureProductFamily(payload.id_familie, name);
    }
  }

  const now = new Date().toISOString();
  const keys = Object.keys(payload);
  if (keys.length > 0) {
    const params = [];
    const sets = keys.map((k) => {
      params.push(payload[k]);
      return `${k} = $${params.length}`;
    });
    params.push(now, id);
    await query(
      `UPDATE catalog_products SET ${sets.join(", ")}, updated_at = $${params.length - 1} WHERE id = $${params.length}`,
      params
    );
  }

  const listingPayload = {};
  for (const [key, coerce] of Object.entries(PRODUCT_LISTING_EDITABLE)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      listingPayload[key] = coerce(fields[key]);
    }
  }

  if (Object.keys(listingPayload).length > 0) {
    const { rows: offerRows } = await query(
      "SELECT emag_offer_id FROM catalog_products WHERE id = $1",
      [id]
    );
    const ext = offerRows[0]?.emag_offer_id;
    if (ext != null) {
      await upsertEmagListingFields(id, ext, listingPayload, now);
    }
  }

  if (touchesPretCumparareInputs(payload)) {
    await recalcPretCumparare([id]);
  }

  return getProduct(id);
}

/** Randul din catalog (cu familie si override-urile eMAG) al unui produs, sau null. */
async function getProduct(productId) {
  await ensureSchema();
  const id = Number(productId);
  if (!Number.isFinite(id)) return null;
  const { rows } = await query(
    `${SQL_CATALOG_WITH_FAMILIE} WHERE c.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function upsertCatalogProducts(items) {
  await ensureSchema();
  const now = new Date().toISOString();
  const list = Array.isArray(items) ? items : [];

  return withTransaction(async (client) => {
    let count = 0;
    for (const r of list) {
      const cod = toTextOrNull(r?.cod_produs);
      const nume = toTextOrNull(r?.nume) || cod;
      if (!cod && !nume) continue;

      const descriere = toTextOrNull(r?.descriere);
      const brand = toTextOrNull(r?.brand);
      const ean = toTextOrNull(r?.ean);
      const pret = toNumOrNull(r?.pret_cumparare);
      const pretUsd = Object.prototype.hasOwnProperty.call(r || {}, "pret_cumparare_usd")
        ? toNumOrNull(r.pret_cumparare_usd)
        : undefined;
      const link = Object.prototype.hasOwnProperty.call(r || {}, "link_cumparare")
        ? toTextOrNull(r.link_cumparare)
        : undefined;
      const partNumber = toTextOrNull(r?.part_number) || cod;
      const partNumberKey = toTextOrNull(r?.part_number_key);
      const idFamilie = toNumOrNull(r?.id_familie);
      const familieName = toTextOrNull(r?.familie);
      const salePrice = toNumOrNull(r?.sale_price);
      const recommendedPrice = toNumOrNull(r?.recommended_price);
      const minSalePrice = toNumOrNull(r?.min_sale_price);
      const maxSalePrice = toNumOrNull(r?.max_sale_price);
      const generalStock = toNumOrNull(r?.general_stock);
      const currency = toTextOrNull(r?.currency) || "RON";

      await ensureProductFamily(idFamilie, familieName, client);

      if (cod) {
        const conflictSets = [
          "nume = COALESCE(EXCLUDED.nume, catalog_products.nume)",
          "descriere = COALESCE(EXCLUDED.descriere, catalog_products.descriere)",
          "brand = COALESCE(EXCLUDED.brand, catalog_products.brand)",
          "ean = COALESCE(EXCLUDED.ean, catalog_products.ean)",
          "pret_cumparare = COALESCE(EXCLUDED.pret_cumparare, catalog_products.pret_cumparare)",
          "part_number = COALESCE(EXCLUDED.part_number, catalog_products.part_number)",
          "part_number_key = COALESCE(EXCLUDED.part_number_key, catalog_products.part_number_key)",
          "id_familie = COALESCE(EXCLUDED.id_familie, catalog_products.id_familie)",
          "sale_price = COALESCE(EXCLUDED.sale_price, catalog_products.sale_price)",
          "recommended_price = COALESCE(EXCLUDED.recommended_price, catalog_products.recommended_price)",
          "min_sale_price = COALESCE(EXCLUDED.min_sale_price, catalog_products.min_sale_price)",
          "max_sale_price = COALESCE(EXCLUDED.max_sale_price, catalog_products.max_sale_price)",
          "general_stock = COALESCE(EXCLUDED.general_stock, catalog_products.general_stock)",
          "currency = COALESCE(EXCLUDED.currency, catalog_products.currency)",
          "updated_at = EXCLUDED.updated_at",
        ];
        if (pretUsd !== undefined) {
          conflictSets.push("pret_cumparare_usd = EXCLUDED.pret_cumparare_usd");
        }
        if (link !== undefined) {
          conflictSets.push("link_cumparare = EXCLUDED.link_cumparare");
        }
        await client.query(
          `INSERT INTO catalog_products (
             cod_produs, nume, descriere, brand, ean, pret_cumparare,
             pret_cumparare_usd, link_cumparare,
             part_number, part_number_key, id_familie,
             sale_price, recommended_price, min_sale_price, max_sale_price,
             general_stock, currency, created_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,
             $7,$8,
             $9,$10,$11,
             $12,$13,$14,$15,
             $16,$17,$18,$18
           )
           ON CONFLICT (cod_produs) DO UPDATE SET ${conflictSets.join(", ")}`,
          [
            cod,
            nume,
            descriere,
            brand,
            ean,
            pret,
            pretUsd ?? null,
            link ?? null,
            partNumber,
            partNumberKey,
            idFamilie,
            salePrice,
            recommendedPrice,
            minSalePrice,
            maxSalePrice,
            generalStock,
            currency,
            now,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO catalog_products (
             cod_produs, nume, descriere, brand, ean, pret_cumparare,
             pret_cumparare_usd, link_cumparare,
             part_number, part_number_key, id_familie,
             sale_price, recommended_price, min_sale_price, max_sale_price,
             general_stock, currency, created_at, updated_at
           ) VALUES (
             NULL,$1,$2,$3,$4,$5,
             $6,$7,
             $8,$9,$10,
             $11,$12,$13,$14,
             $15,$16,$17,$17
           )`,
          [
            nume,
            descriere,
            brand,
            ean,
            pret,
            pretUsd ?? null,
            link ?? null,
            partNumber,
            partNumberKey,
            idFamilie,
            salePrice,
            recommendedPrice,
            minSalePrice,
            maxSalePrice,
            generalStock,
            currency,
            now,
          ]
        );
      }
      count += 1;
    }
    return count;
  });
}

/**
 * Actualizeaza doar pret_cumparare_usd / link_cumparare pe produse existente,
 * potrivite dupa cod_produs, EAN sau part_number_key (PNK).
 */
async function updateCatalogPurchaseMeta(items) {
  await ensureSchema();
  const now = new Date().toISOString();
  const list = Array.isArray(items) ? items : [];
  let updated = 0;
  let unmatched = 0;

  await withTransaction(async (client) => {
    for (const r of list) {
      const hasUsd = Object.prototype.hasOwnProperty.call(r || {}, "pret_cumparare_usd");
      const hasLink = Object.prototype.hasOwnProperty.call(r || {}, "link_cumparare");
      if (!hasUsd && !hasLink) continue;

      const pretUsd = hasUsd ? toNumOrNull(r.pret_cumparare_usd) : undefined;
      const link = hasLink ? toTextOrNull(r.link_cumparare) : undefined;

      const buildSet = () => {
        const sets = ["updated_at = $1"];
        const params = [now];
        if (hasUsd) {
          params.push(pretUsd);
          sets.push(`pret_cumparare_usd = $${params.length}`);
        }
        if (hasLink) {
          params.push(link);
          sets.push(`link_cumparare = $${params.length}`);
        }
        return { sets, params };
      };

      const cod = toTextOrNull(r?.cod_produs);
      const ean = normalizeEan(r?.ean);
      const pnk = toTextOrNull(r?.part_number_key);

      let rowCount = 0;
      if (cod) {
        const { sets, params } = buildSet();
        params.push(cod);
        const result = await client.query(
          `UPDATE catalog_products SET ${sets.join(", ")}
           WHERE LOWER(cod_produs) = LOWER($${params.length})`,
          params
        );
        rowCount = result.rowCount || 0;
      }
      if (rowCount === 0 && ean) {
        const { sets, params } = buildSet();
        params.push(ean);
        const result = await client.query(
          `UPDATE catalog_products SET ${sets.join(", ")}
           WHERE LOWER(TRIM(SPLIT_PART(ean, ',', 1))) = $${params.length}`,
          params
        );
        rowCount = result.rowCount || 0;
      }
      if (rowCount === 0 && pnk) {
        const { sets, params } = buildSet();
        params.push(pnk);
        const result = await client.query(
          `UPDATE catalog_products SET ${sets.join(", ")}
           WHERE LOWER(part_number_key) = LOWER($${params.length})`,
          params
        );
        rowCount = result.rowCount || 0;
      }

      if (rowCount > 0) updated += rowCount;
      else unmatched += 1;
    }
    await recalcPretCumparare(null, client);
  });

  return { updated, unmatched };
}

async function getChannelStats(channel) {
  await ensureSchema();
  const ch = normalizeChannel(channel);
  const meta = getCacheMeta(ch);

  if (ch === "trendyol") {
    return {
      channel: ch,
      listings: meta.count,
      snapshots: meta.count,
      last_sync: meta.fetchedAt,
    };
  }

  assertEmagSot(ch);
  const { rows } = await query(
    "SELECT COUNT(*)::int AS n FROM catalog_products WHERE emag_offer_id IS NOT NULL"
  );
  const listingsCount = rows[0]?.n ?? 0;
  return {
    channel: ch,
    listings: listingsCount,
    snapshots: meta.count,
    last_sync: meta.fetchedAt,
  };
}

module.exports = {
  CHANNELS,
  normalizeChannel,
  ensureSchema,
  setChannelRemotes,
  upsertChannelRemote,
  getChannelRemotes,
  clearChannelCache,
  getCatalogRows,
  updateListing,
  getListing,
  updateProduct,
  getProduct,
  getProductOfferId,
  upsertCatalogProducts,
  updateCatalogPurchaseMeta,
  getChannelStats,
  recalcPretCumparare,
  touchesPretCumparareInputs,
  };
