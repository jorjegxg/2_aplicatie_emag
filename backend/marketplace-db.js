/**
 * Stratul multi-canal peste Postgres.
 *
 * catalog_products      — SoT local eMAG (preturi, identitate, pret_cumparare); nu se umple din pull
 * marketplace_listings  — override-uri locale eMAG (costuri, comision, pret_minim)
 * channel-remote-cache  — oglinda remote a canalului (TTL memorie; pull + push status/vat/handling)
 */
const { query, withTransaction, ensureSchema: ensurePgSchema } = require("./pg");
const { getLastPriceChangeBulk } = require("./db");
const { htmlToText, looksLikeHtml } = require("./description-format");
const { listByProductIds } = require("./product-images");
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

function toPlainTextOrNull(v) {
  if (v == null) return null;
  const s = looksLikeHtml(v) ? htmlToText(v) : String(v);
  return s === "" ? null : s;
}

/** Mereu string JSON (sau null). Array JS nu merge direct in JSONB via pg — pg il trateaza ca array PG. */
function jsonOrNull(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    try {
      JSON.parse(s);
      return s;
    } catch {
      return null;
    }
  }
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return null;
    }
  }
  return null;
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
         ml.commission_fetched_at
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

function parseJson(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
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

/**
 * Catalog indexat pe EAN normalizat (primul castiga la duplicate).
 * Folosit de sync Trendyol: join channel-view + diff.
 */
async function getCatalogMappedByEan() {
  await ensureSchema();
  const { rows } = await query(
    `${SQL_CATALOG_WITH_FAMILIE}
     WHERE c.ean IS NOT NULL AND TRIM(c.ean) <> ''
     ORDER BY c.id ASC`
  );
  const products = rows.map(mapCatalogRowToProduct);

  const lastChanges = await getLastPriceChangeBulk(products.map((p) => p.id));
  for (const p of products) {
    const lc = lastChanges[p.id];
    p.pret_emag_last_change = lc ? lc.recorded_at : null;
  }

  const imageMap = await listByProductIds(
    products.map((p) => p.product_id).filter((id) => id != null)
  );
  for (const p of products) {
    const pid = Number(p.product_id);
    p.images = Number.isFinite(pid) ? imageMap.get(pid) || [] : [];
  }

  const byEan = new Map();
  for (let i = 0; i < products.length; i++) {
    const ean = normalizeEan(rows[i].ean);
    if (!ean || byEan.has(ean)) continue;
    byEan.set(ean, products[i]);
  }
  return byEan;
}

/** Intai dupa SKU, apoi dupa EAN, apoi dupa nume exact. */
async function findCatalogProductId(remote) {
  await ensureSchema();
  const sku = toTextOrNull(remote.part_number);
  if (sku) {
    const { rows } = await query(
      "SELECT id FROM catalog_products WHERE LOWER(cod_produs) = LOWER($1) LIMIT 1",
      [sku]
    );
    if (rows[0]) return rows[0].id;
  }
  const ean = normalizeEan(remote.ean);
  if (ean) {
    const { rows } = await query(
      "SELECT id FROM catalog_products WHERE LOWER(TRIM(SPLIT_PART(ean, ',', 1))) = $1 LIMIT 1",
      [ean]
    );
    if (rows[0]) return rows[0].id;
  }
  const name = toTextOrNull(remote.name ?? remote.nume);
  if (name) {
    const { rows } = await query(
      "SELECT id FROM catalog_products WHERE LOWER(nume) = LOWER($1) LIMIT 1",
      [name]
    );
    if (rows[0]) return rows[0].id;
  }
  return null;
}

/** Normalizeaza remote-ul canalului la shape-ul folosit de diff. */
function remoteToSnapshotShape(remote, fetchedAt) {
  return {
    external_id: String(remote.id),
    name: toTextOrNull(remote.name),
    description: toPlainTextOrNull(remote.description),
    part_number: toTextOrNull(remote.part_number),
    ean: toTextOrNull(remote.ean),
    brand: toTextOrNull(remote.brand),
    sale_price: toNumOrNull(remote.sale_price),
    recommended_price: toNumOrNull(remote.recommended_price),
    min_sale_price: toNumOrNull(remote.min_sale_price),
    max_sale_price: toNumOrNull(remote.max_sale_price),
    general_stock: toNumOrNull(remote.general_stock),
    status: toNumOrNull(remote.status),
    vat_id: toNumOrNull(remote.vat_id),
    currency: toTextOrNull(remote.currency),
    fetched_at: fetchedAt,
  };
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
    link_cumparare: toTextOrNull(r.link_cumparare) || "",
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

  const imageMap = await listByProductIds(
    products.map((p) => p.product_id).filter((id) => id != null)
  );
  for (const p of products) {
    const pid = Number(p.product_id);
    p.images = Number.isFinite(pid) ? imageMap.get(pid) || [] : [];
  }
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
};

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

/** Listings pentru push Trendyol: potrivire pe EAN/barcode (external_id = barcode cerut). */
async function getListingsByEan(externalIds) {
  const ids = [...new Set((externalIds || []).map((v) => String(v)).filter(Boolean))];
  if (ids.length === 0) return [];

  const { rows } = await query(
    `${SQL_CATALOG_WITH_FAMILIE}
     WHERE c.ean IS NOT NULL AND TRIM(c.ean) <> ''
     ORDER BY c.id ASC`
  );

  const byEan = new Map();
  for (const row of rows) {
    const ean = normalizeEan(row.ean);
    if (!ean || byEan.has(ean)) continue;
    byEan.set(ean, row);
  }

  const out = [];
  for (const id of ids) {
    const ean = normalizeEan(id);
    const row = ean ? byEan.get(ean) : null;
    if (!row) continue;
    out.push(catalogToListingShape(row, { channel: "trendyol", externalId: id }));
  }
  return out;
}

async function getListings(channel, externalIds) {
  await ensureSchema();
  const ch = normalizeChannel(channel);
  if (ch === "trendyol") return getListingsByEan(externalIds);

  assertEmagSot(channel);
  const ids = [...new Set((externalIds || []).map((v) => String(v)).filter(Boolean))];
  if (ids.length === 0) return [];

  const { rows } = await query(
    `${SQL_CATALOG_WITH_FAMILIE}
     WHERE c.emag_offer_id = ANY($1::text[])`,
    [ids]
  );
  return rows.map((r) => catalogToListingShape(r));
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
  });

  return { updated, unmatched };
}

const DIFF_FIELDS = [
  { key: "name", label: "Nume", type: "text" },
  { key: "description", label: "Descriere", type: "text" },
  { key: "sale_price", label: "Preț vânzare", type: "number" },
  { key: "recommended_price", label: "PRP", type: "number" },
  { key: "min_sale_price", label: "Preț minim", type: "number" },
  { key: "max_sale_price", label: "Preț maxim", type: "number" },
  { key: "general_stock", label: "Stoc", type: "number" },
];

/** Trendyol nu expune min/max — le excludem ca sa nu marcheze totul ca diferit. */
const DIFF_FIELDS_TRENDYOL = DIFF_FIELDS.filter(
  (f) => f.key !== "min_sale_price" && f.key !== "max_sale_price"
);

function valuesDiffer(type, mine, theirs) {
  if (mine == null && theirs == null) return false;
  if (mine == null || theirs == null) return true;
  if (type === "number") {
    const a = Number(mine);
    const b = Number(theirs);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return String(mine) !== String(theirs);
    return Math.abs(a - b) > 0.005;
  }
  return normalizeText(mine) !== normalizeText(theirs);
}

/** Text comparabil: spatii colapsate + trim, ca sa nu raporteze diferente cosmetice. */
function normalizeText(v) {
  return String(v).replace(/\s+/g, " ").trim();
}

/** Valoarea locala pentru un camp de diff: overrides + coloanele RO din catalog. */
function localDiffValue(local, key) {
  if (key === "min_sale_price") {
    return local.pret_minim_override ?? local.min_sale_price ?? null;
  }
  if (key === "name") return toTextOrNull(local.name ?? local.nume);
  if (key === "description") return toPlainTextOrNull(local.descriere);
  return local[key] ?? null;
}

function buildDiffFields(local, snap, fieldDefs) {
  return fieldDefs.map((f) => {
    const mine = localDiffValue(local, f.key);
    const theirs = snap[f.key] ?? null;
    return {
      key: f.key,
      label: f.label,
      mine,
      theirs,
      differs: valuesDiffer(f.type, mine, theirs),
    };
  });
}

function onlyRemoteEntry(s) {
  return {
    external_id: s.external_id,
    part_number: s.part_number,
    name: s.name,
    sale_price: s.sale_price,
    general_stock: s.general_stock,
    fetched_at: s.fetched_at,
  };
}

async function getEmagChannelDiff() {
  const ch = "emag";
  const { rows: locals } = await query(
    `SELECT c.*, pf.name AS familie,
            c.cod_produs AS catalog_cod, c.id AS product_id,
            c.emag_offer_id AS external_id, c.nume AS name,
            ml.pret_minim_override
     FROM catalog_products c
     LEFT JOIN product_families pf ON pf.id = c.id_familie
     LEFT JOIN marketplace_listings ml
       ON ml.channel = 'emag' AND ml.external_id = c.emag_offer_id
     WHERE c.emag_offer_id IS NOT NULL
     ORDER BY CAST(NULLIF(c.emag_offer_id, '') AS BIGINT) ASC NULLS LAST`
  );

  const snapByExt = new Map();
  let cacheFetchedAt = null;

  const cache = getChannelRemotes(ch);
  if (cache) {
    cacheFetchedAt = cache.fetchedAt;
    for (const [ext, remote] of cache.byId) {
      snapByExt.set(ext, remoteToSnapshotShape(remote, cache.fetchedAt));
    }
  }

  const matched = [];
  const onlyLocal = [];

  for (const l of locals) {
    const ext = String(l.external_id);
    const snap = snapByExt.get(ext);
    if (!snap) {
      onlyLocal.push({
        external_id: l.external_id,
        part_number: l.part_number,
        name: l.name,
        sale_price: l.sale_price,
        general_stock: l.general_stock,
      });
      continue;
    }
    snapByExt.delete(ext);
    const fields = buildDiffFields(l, snap, DIFF_FIELDS);
    matched.push({
      external_id: l.external_id,
      part_number: l.part_number || snap.part_number || "",
      catalog_cod: l.catalog_cod || null,
      product_id: l.product_id,
      fetched_at: snap.fetched_at,
      diff_count: fields.filter((f) => f.differs).length,
      fields,
    });
  }

  const onlyRemote = [...snapByExt.values()].map(onlyRemoteEntry);

  const unlinked = locals
    .filter((l) => !l.cod_produs && !l.catalog_cod)
    .map((l) => ({
      external_id: l.external_id,
      part_number: l.part_number,
      name: l.name,
    }));

  const stats = await getChannelStats(ch);
  return {
    channel: ch,
    last_sync: stats.last_sync ?? cacheFetchedAt,
    fields: DIFF_FIELDS,
    matched,
    only_local: onlyLocal,
    only_remote: onlyRemote,
    unlinked,
  };
}

/** Diff Trendyol: potrivire pe EAN/barcode; external_id in raspuns = barcode remote. */
async function getTrendyolChannelDiff() {
  const ch = "trendyol";
  const { rows: locals } = await query(
    `SELECT c.*, pf.name AS familie,
            c.cod_produs AS catalog_cod, c.id AS product_id,
            c.nume AS name,
            ml.pret_minim_override
     FROM catalog_products c
     LEFT JOIN product_families pf ON pf.id = c.id_familie
     LEFT JOIN marketplace_listings ml
       ON ml.channel = 'emag' AND ml.external_id = c.emag_offer_id
     WHERE c.ean IS NOT NULL AND TRIM(c.ean) <> ''
     ORDER BY c.id ASC`
  );

  const snapByEan = new Map();
  const onlyRemoteExtra = [];
  let cacheFetchedAt = null;

  const cache = getChannelRemotes(ch);
  if (cache) {
    cacheFetchedAt = cache.fetchedAt;
    for (const [, remote] of cache.byId) {
      const snap = remoteToSnapshotShape(remote, cache.fetchedAt);
      const ean = normalizeEan(remote.ean) || normalizeEan(remote.id);
      if (!ean) {
        onlyRemoteExtra.push(snap);
        continue;
      }
      if (snapByEan.has(ean)) {
        onlyRemoteExtra.push(snap);
        continue;
      }
      snapByEan.set(ean, snap);
    }
  }

  const matched = [];
  const onlyLocal = [];
  const seenLocalEan = new Set();

  for (const l of locals) {
    const ean = normalizeEan(l.ean);
    if (!ean || seenLocalEan.has(ean)) continue;
    seenLocalEan.add(ean);

    const snap = snapByEan.get(ean);
    if (!snap) {
      onlyLocal.push({
        external_id: ean,
        part_number: l.part_number || l.cod_produs || "",
        name: l.name,
        sale_price: l.sale_price,
        general_stock: l.general_stock,
      });
      continue;
    }
    snapByEan.delete(ean);
    const fields = buildDiffFields(l, snap, DIFF_FIELDS_TRENDYOL);
    matched.push({
      external_id: snap.external_id,
      part_number: l.part_number || l.cod_produs || snap.part_number || "",
      catalog_cod: l.catalog_cod || null,
      product_id: l.product_id,
      fetched_at: snap.fetched_at,
      diff_count: fields.filter((f) => f.differs).length,
      fields,
    });
  }

  const onlyRemote = [...snapByEan.values(), ...onlyRemoteExtra].map(onlyRemoteEntry);

  const unlinked = locals
    .filter((l) => {
      const ean = normalizeEan(l.ean);
      return ean && !l.cod_produs && !l.catalog_cod;
    })
    .map((l) => ({
      external_id: normalizeEan(l.ean),
      part_number: l.part_number,
      name: l.name,
    }));

  const stats = await getChannelStats(ch);
  return {
    channel: ch,
    last_sync: stats.last_sync ?? cacheFetchedAt,
    fields: DIFF_FIELDS_TRENDYOL,
    matched,
    only_local: onlyLocal,
    only_remote: onlyRemote,
    unlinked,
  };
}

async function getChannelDiff(channel) {
  await ensureSchema();
  const ch = normalizeChannel(channel);
  if (ch === "trendyol") return getTrendyolChannelDiff();
  return getEmagChannelDiff();
}

/**
 * Randurile pentru pagina de sincronizare: coloanele marcate `data-src="channel"`
 * vin din oglinda remote a canalului (cache memorie, umplut de /api/sync/pull),
 * iar cele `data-src="db"` / `calc` din catalogul local. Iterez peste cache, deci
 * pagina arata exact ce e pe canal, inclusiv oferte fara corespondent local.
 */
function remoteToViewRow(remote) {
  const fam = remote.familie ?? remote.family_name ?? "";
  return {
    id: remote.id,
    name: toTextOrNull(remote.name) || "",
    description: toTextOrNull(remote.description) || "",
    brand: toTextOrNull(remote.brand) || "",
    part_number: toTextOrNull(remote.part_number) || "",
    part_number_key: toTextOrNull(remote.part_number_key) || "",
    id_familie: remote.id_familie ?? null,
    familie: fam || "",
    ean: toTextOrNull(remote.ean) || "",
    remote_sale_price: toNumOrNull(remote.sale_price),
    recommended_price: toNumOrNull(remote.recommended_price),
    min_sale_price: toNumOrNull(remote.min_sale_price),
    max_sale_price: toNumOrNull(remote.max_sale_price),
    general_stock: toNumOrNull(remote.general_stock),
    stock: Array.isArray(remote.stock) ? remote.stock : [],
    status: toNumOrNull(remote.status),
    vat_id: toNumOrNull(remote.vat_id),
    currency: toTextOrNull(remote.currency) || "RON",
    characteristics: toTextOrNull(remote.characteristics) || "",
    commission_rate: toNumOrNull(remote.commission_rate),
  };
}

async function getChannelViewRows(channel) {
  await ensureSchema();
  const ch = normalizeChannel(channel);

  const cache = getChannelRemotes(ch);
  if (!cache) {
    return { channel: ch, cached: false, fetched_at: null, count: 0, products: [] };
  }

  const localByKey = new Map();
  if (ch === "emag") {
    for (const p of await getCatalogRows(ch)) localByKey.set(String(p.id), p);
  } else if (ch === "trendyol") {
    const byEan = await getCatalogMappedByEan();
    for (const [ean, p] of byEan) localByKey.set(ean, p);
  }

  const products = [];
  for (const [ext, remote] of cache.byId) {
    const view = remoteToViewRow(remote);
    let local = null;
    if (ch === "emag") {
      local = localByKey.get(String(ext)) || null;
    } else if (ch === "trendyol") {
      const ean = normalizeEan(remote.ean) || normalizeEan(remote.id) || normalizeEan(ext);
      local = ean ? localByKey.get(ean) || null : null;
    }
    // Comisionul: pe eMAG e override-ul local din listing, pe Trendyol vine
    // direct din oglinda canalului (nu se persista nicaieri local).
    const commissionSource =
      ch === "trendyol" && view.commission_rate != null ? "trendyol" : "emag";
    products.push({
      ...view,
      channel: ch,
      has_local: Boolean(local),
      product_id: local ? local.product_id : null,
      sale_price: local ? local.sale_price : null,
      pret_cumparare: local ? local.pret_cumparare : null,
      transport_override: local ? local.transport_override : null,
      pret_minim_override: local ? local.pret_minim_override : null,
      procentaj_emag: local ? local.procentaj_emag : null,
      commission_value: local ? local.commission_value : null,
      commission_fetched_at: local ? local.commission_fetched_at : null,
      commission_source: commissionSource,
      channel_commission_pct:
        commissionSource === "trendyol"
          ? view.commission_rate
          : local
          ? local.procentaj_emag
          : null,
      pret_emag_last_change: local ? local.pret_emag_last_change : null,
      images: local ? local.images : [],
    });
  }

  products.sort((a, b) => {
    const na = Number(a.id);
    const nb = Number(b.id);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a.id).localeCompare(String(b.id));
  });

  return {
    channel: ch,
    cached: true,
    fetched_at: cache.fetchedAt,
    count: products.length,
    products,
  };
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

async function getListingCosts(channel, externalId) {
  const row = await getListing(channel, externalId);
  if (!row) return null;
  return {
    transport_override: row.transport_override ?? null,
    procentaj_emag: row.procentaj_emag ?? null,
    commission_value: row.commission_value ?? null,
    commission_fetched_at: row.commission_fetched_at ?? null,
  };
}

async function lookupCatalogPretCumparare(partNumber, name) {
  await ensureSchema();
  const cod = toTextOrNull(partNumber);
  if (cod) {
    const { rows } = await query(
      "SELECT pret_cumparare FROM catalog_products WHERE LOWER(cod_produs) = LOWER($1) LIMIT 1",
      [cod]
    );
    if (rows[0] && rows[0].pret_cumparare != null) return rows[0].pret_cumparare;
  }
  const nume = toTextOrNull(name);
  if (nume) {
    const { rows } = await query(
      "SELECT pret_cumparare FROM catalog_products WHERE LOWER(nume) = LOWER($1) LIMIT 1",
      [nume]
    );
    if (rows[0] && rows[0].pret_cumparare != null) return rows[0].pret_cumparare;
  }
  return null;
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
  getListings,
  updateProduct,
  upsertCatalogProducts,
  updateCatalogPurchaseMeta,
  getChannelDiff,
  getChannelViewRows,
  getChannelStats,
  getListingCosts,
  lookupCatalogPretCumparare,
};
