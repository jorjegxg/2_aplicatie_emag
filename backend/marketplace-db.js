/**
 * Stratul multi-canal peste Postgres.
 *
 * catalog_products      — SoT local eMAG (preturi, identitate, pret_cumparare); nu se umple din pull
 * marketplace_listings  — eMAG: doar override-uri locale (costuri, pret_minim); alte canale SoT
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
  clearChannelCache,
} = require("./channel-remote-cache");

const CHANNELS = ["emag", "trendyol"];

function normalizeChannel(channel) {
  const c = String(channel || "emag").trim().toLowerCase();
  return CHANNELS.includes(c) ? c : "emag";
}

function isEmagSot(channel) {
  return normalizeChannel(channel) === "emag";
}

/** Coloane pe catalog — legacy; eMAG pull nu mai scrie pe catalog. */
const LOCAL_SEED_FIELDS = [
  "name",
  "description",
  "sale_price",
  "recommended_price",
  "min_sale_price",
  "max_sale_price",
  "general_stock",
  "stock_json",
];

const CHANNEL_OWNED_FIELDS = [
  "part_number",
  "part_number_key",
  "brand",
  "ean",
  "id_familie",
  "characteristics",
  "estimated_stock",
  "handling_time_json",
  "status",
  "vat_id",
  "currency",
];

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

/** Costuri/comision pe listings (nu pe catalog). */
const LISTING_COST_FIELDS = [
  "alte_costuri",
  "procentaj_emag",
  "commission_value",
  "commission_fetched_at",
];

/** Catalog + familie + override-uri locale din marketplace_listings (eMAG). */
const SQL_CATALOG_WITH_FAMILIE = `
  SELECT c.*, pf.name AS familie,
         ml.alte_costuri,
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
function catalogToListingShape(row) {
  if (!row) return null;
  return {
    ...row,
    channel: "emag",
    external_id: row.emag_offer_id,
    name: row.nume,
    description: row.descriere,
    product_id: row.id,
  };
}

async function ensureSchema() {
  await ensurePgSchema();
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
  const ean = toTextOrNull(remote.ean);
  if (ean) {
    const first = ean.split(",")[0].trim();
    if (first) {
      const { rows } = await query(
        "SELECT id FROM catalog_products WHERE LOWER(ean) = LOWER($1) LIMIT 1",
        [first]
      );
      if (rows[0]) return rows[0].id;
    }
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

async function upsertListingFromRemoteLegacy(channel, remote) {
  const ch = normalizeChannel(channel);
  const ext = String(remote.id);
  const now = new Date().toISOString();

  const { rows: existingRows } = await query(
    "SELECT id, product_id FROM marketplace_listings WHERE channel = $1 AND external_id = $2",
    [ch, ext]
  );
  const existing = existingRows[0];

  const channelValues = {
    part_number: toTextOrNull(remote.part_number),
    part_number_key: toTextOrNull(remote.part_number_key),
    brand: toTextOrNull(remote.brand),
    ean: toTextOrNull(remote.ean),
    id_familie: toNumOrNull(remote.id_familie),
    characteristics: toTextOrNull(remote.characteristics),
    estimated_stock: toNumOrNull(remote.estimated_stock),
    handling_time_json: jsonOrNull(remote.handling_time),
    status: toNumOrNull(remote.status),
    vat_id: toNumOrNull(remote.vat_id),
    currency: toTextOrNull(remote.currency),
  };

  await ensureProductFamily(channelValues.id_familie, remote.familie);

  if (!existing) {
    await query(
      `INSERT INTO marketplace_listings
         (channel, external_id, product_id, part_number, part_number_key, name, description,
          brand, ean, id_familie, characteristics,
          sale_price, recommended_price, min_sale_price, max_sale_price,
          general_stock, estimated_stock, stock_json, handling_time_json,
          status, vat_id, currency, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
      [
        ch,
        ext,
        await findCatalogProductId(remote),
        channelValues.part_number,
        channelValues.part_number_key,
        toTextOrNull(remote.name),
        toTextOrNull(remote.description),
        channelValues.brand,
        channelValues.ean,
        channelValues.id_familie,
        channelValues.characteristics,
        toNumOrNull(remote.sale_price),
        toNumOrNull(remote.recommended_price),
        toNumOrNull(remote.min_sale_price),
        toNumOrNull(remote.max_sale_price),
        toNumOrNull(remote.general_stock),
        channelValues.estimated_stock,
        jsonOrNull(remote.stock),
        channelValues.handling_time_json,
        channelValues.status,
        channelValues.vat_id,
        channelValues.currency,
        now,
        now,
      ]
    );
    return { created: true };
  }

  const seedValues = {
    name: toTextOrNull(remote.name),
    description: toTextOrNull(remote.description),
    sale_price: toNumOrNull(remote.sale_price),
    recommended_price: toNumOrNull(remote.recommended_price),
    min_sale_price: toNumOrNull(remote.min_sale_price),
    max_sale_price: toNumOrNull(remote.max_sale_price),
    general_stock: toNumOrNull(remote.general_stock),
    stock_json: jsonOrNull(remote.stock),
  };

  const params = [];
  const sets = [
    ...CHANNEL_OWNED_FIELDS.map((f) => {
      params.push(channelValues[f]);
      return `${f} = $${params.length}`;
    }),
    ...LOCAL_SEED_FIELDS.map((f) => {
      params.push(seedValues[f]);
      return `${f} = COALESCE(${f}, $${params.length})`;
    }),
  ];
  params.push(now, ch, ext);
  await query(
    `UPDATE marketplace_listings SET ${sets.join(", ")}, updated_at = $${params.length - 2}
     WHERE channel = $${params.length - 1} AND external_id = $${params.length}`,
    params
  );

  if (existing.product_id == null) {
    const productId = await findCatalogProductId(remote);
    if (productId != null) {
      await query("UPDATE marketplace_listings SET product_id = $1 WHERE id = $2", [
        productId,
        existing.id,
      ]);
    }
  }
  return { created: false };
}

async function upsertListingFromRemote(channel, remote) {
  await ensureSchema();
  // eMAG: pull scrie doar în channel-remote-cache; catalogul rămâne SoT local.
  if (isEmagSot(channel)) return { created: false };
  return upsertListingFromRemoteLegacy(channel, remote);
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
    alte_costuri: toNumOrNull(r.alte_costuri),
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

function mapListingRowToProduct(r) {
  return {
    id: Number(r.external_id) || r.external_id,
    channel: r.channel,
    product_id: r.product_id,
    name: r.name || "",
    description: r.description || "",
    brand: r.brand || "",
    part_number: r.part_number || "",
    part_number_key: r.part_number_key || "",
    id_familie: r.id_familie ?? null,
    familie: r.familie || "",
    sale_price: toNumOrNull(r.sale_price),
    recommended_price: toNumOrNull(r.recommended_price),
    min_sale_price: toNumOrNull(r.min_sale_price),
    max_sale_price: toNumOrNull(r.max_sale_price),
    pret_cumparare: toNumOrNull(r.catalog_pret_cumparare),
    alte_costuri: toNumOrNull(r.alte_costuri),
    pret_minim_override: toNumOrNull(r.pret_minim_override),
    procentaj_emag: toNumOrNull(r.procentaj_emag),
    commission_value: toNumOrNull(r.commission_value),
    commission_fetched_at:
      r.commission_fetched_at instanceof Date
        ? r.commission_fetched_at.toISOString()
        : r.commission_fetched_at ?? null,
    currency: r.currency || "RON",
    general_stock: toNumOrNull(r.general_stock),
    estimated_stock: toNumOrNull(r.estimated_stock),
    status: r.status,
    vat_id: r.vat_id ?? null,
    handling_time: parseJson(r.handling_time_json, [{ warehouse_id: 1, value: 0 }]),
    stock:
      parseJson(r.stock_json, null) || [
        { warehouse_id: 1, value: Number(r.general_stock) || 0 },
      ],
    ean: r.ean || "",
    characteristics: r.characteristics || "",
    images: [],
  };
}

async function getCatalogRows(channel) {
  await ensureSchema();
  const ch = normalizeChannel(channel);

  let products;
  if (isEmagSot(ch)) {
    const { rows } = await query(
      `${SQL_CATALOG_WITH_FAMILIE}
       WHERE c.emag_offer_id IS NOT NULL
       ORDER BY CAST(NULLIF(c.emag_offer_id, '') AS BIGINT) ASC NULLS LAST`
    );
    products = rows.map(mapCatalogRowToProduct);
  } else {
    const { rows } = await query(
      `SELECT l.*, pf.name AS familie, c.pret_cumparare AS catalog_pret_cumparare, c.cod_produs AS catalog_cod
       FROM marketplace_listings l
       LEFT JOIN product_families pf ON pf.id = l.id_familie
       LEFT JOIN catalog_products c ON c.id = l.product_id
       WHERE l.channel = $1
       ORDER BY CAST(NULLIF(l.external_id, '') AS BIGINT) ASC NULLS LAST`,
      [ch]
    );
    products = rows.map(mapListingRowToProduct);
  }

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
  alte_costuri: toNumOrNull,
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

/** Map API field names → catalog columns (fără oferta/costuri — pe listings). */
const LISTING_TO_CATALOG_COL = {
  name: "nume",
  description: "descriere",
  sale_price: "sale_price",
  recommended_price: "recommended_price",
  min_sale_price: "min_sale_price",
  max_sale_price: "max_sale_price",
  general_stock: "general_stock",
};

async function setListingPretCumparare(channel, externalId, value) {
  await ensureSchema();
  const price = toNumOrNull(value);
  const now = new Date().toISOString();

  if (isEmagSot(channel)) {
    const listing = await getListing(channel, externalId);
    if (!listing) throw new Error("Listing inexistent");
    await query(
      "UPDATE catalog_products SET pret_cumparare = $1, updated_at = $2 WHERE id = $3",
      [price, now, listing.product_id]
    );
    return listing.product_id;
  }

  const listing = await getListing(channel, externalId);
  if (!listing) throw new Error("Listing inexistent");

  let productId = listing.product_id;
  if (productId == null) {
    productId = await findCatalogProductId(listing);
    if (productId == null) {
      const cod = toTextOrNull(listing.part_number);
      const nume = toTextOrNull(listing.name) || cod;
      const { rows } = await query(
        `INSERT INTO catalog_products (cod_produs, nume, pret_cumparare, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [cod, nume, price, now, now]
      );
      productId = Number(rows[0].id);
    }
    await query(
      "UPDATE marketplace_listings SET product_id = $1, updated_at = $2 WHERE id = $3",
      [productId, now, listing.id]
    );
  }

  await query(
    "UPDATE catalog_products SET pret_cumparare = $1, updated_at = $2 WHERE id = $3",
    [price, now, productId]
  );
  return productId;
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

async function updateListingLegacy(channel, externalId, fields) {
  const ch = normalizeChannel(channel);
  const ext = String(externalId ?? "").trim();
  if (!ext) throw new Error("external_id invalid");

  const now = new Date().toISOString();
  await query(
    `INSERT INTO marketplace_listings (channel, external_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (channel, external_id) DO NOTHING`,
    [ch, ext, now, now]
  );

  if (Object.prototype.hasOwnProperty.call(fields, "pret_cumparare")) {
    await setListingPretCumparare(ch, ext, fields.pret_cumparare);
  }

  const payload = {};
  for (const [key, coerce] of Object.entries(LISTING_EDITABLE)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      payload[key] = coerce(fields[key]);
    }
  }
  if (Array.isArray(fields.stock)) {
    payload.stock_json = jsonOrNull(fields.stock);
    payload.general_stock = fields.stock.reduce(
      (sum, s) => sum + (Number(s?.value) || 0),
      0
    );
  }
  if (Array.isArray(fields.handling_time)) {
    payload.handling_time_json = jsonOrNull(fields.handling_time);
  }

  const keys = Object.keys(payload);
  if (keys.length === 0) return getListing(ch, ext);

  const params = [];
  const sets = keys.map((k) => {
    params.push(payload[k]);
    return `${k} = $${params.length}`;
  });
  params.push(now, ch, ext);
  await query(
    `UPDATE marketplace_listings SET ${sets.join(", ")}, updated_at = $${params.length - 2}
     WHERE channel = $${params.length - 1} AND external_id = $${params.length}`,
    params
  );

  return getListing(ch, ext);
}

async function updateListing(channel, externalId, fields) {
  await ensureSchema();
  if (isEmagSot(channel)) return updateListingEmag(externalId, fields);
  return updateListingLegacy(channel, externalId, fields);
}

async function getListing(channel, externalId) {
  await ensureSchema();
  const ext = String(externalId);
  if (isEmagSot(channel)) {
    const { rows } = await query(
      `${SQL_CATALOG_WITH_FAMILIE} WHERE c.emag_offer_id = $1 LIMIT 1`,
      [ext]
    );
    return catalogToListingShape(rows[0] || null);
  }
  const { rows } = await query(
    `SELECT l.*, pf.name AS familie
     FROM marketplace_listings l
     LEFT JOIN product_families pf ON pf.id = l.id_familie
     WHERE l.channel = $1 AND l.external_id = $2`,
    [normalizeChannel(channel), ext]
  );
  return rows[0] || null;
}

async function getListings(channel, externalIds) {
  await ensureSchema();
  const ch = normalizeChannel(channel);
  const ids = [...new Set((externalIds || []).map((v) => String(v)).filter(Boolean))];
  if (ids.length === 0) return [];

  if (isEmagSot(ch)) {
    const { rows } = await query(
      `${SQL_CATALOG_WITH_FAMILIE}
       WHERE c.emag_offer_id = ANY($1::text[])`,
      [ids]
    );
    return rows.map(catalogToListingShape);
  }

  const { rows } = await query(
    `SELECT l.*, pf.name AS familie
     FROM marketplace_listings l
     LEFT JOIN product_families pf ON pf.id = l.id_familie
     WHERE l.channel = $1 AND l.external_id = ANY($2::text[])`,
    [ch, ids]
  );
  return rows;
}

const PRODUCT_EDITABLE = {
  cod_produs: toTextOrNull,
  nume: toTextOrNull,
  descriere: toPlainTextOrNull,
  brand: toTextOrNull,
  ean: toTextOrNull,
  pret_cumparare: toNumOrNull,
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
      const pret = toNumOrNull(r?.pret_cumparare);
      if (cod) {
        await client.query(
          `INSERT INTO catalog_products (cod_produs, nume, pret_cumparare, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (cod_produs) DO UPDATE SET
             nume = EXCLUDED.nume,
             pret_cumparare = EXCLUDED.pret_cumparare,
             updated_at = EXCLUDED.updated_at`,
          [cod, nume, pret, now]
        );
      } else {
        await client.query(
          `INSERT INTO catalog_products (cod_produs, nume, pret_cumparare, created_at, updated_at)
           VALUES (NULL, $1, $2, $3, $3)`,
          [nume, pret, now]
        );
      }
      count += 1;
    }
    return count;
  });
}

const DIFF_FIELDS = [
  { key: "sale_price", label: "Preț vânzare", type: "number" },
  { key: "recommended_price", label: "PRP", type: "number" },
  { key: "min_sale_price", label: "Preț minim", type: "number" },
  { key: "max_sale_price", label: "Preț maxim", type: "number" },
  { key: "general_stock", label: "Stoc", type: "number" },
];

function valuesDiffer(type, mine, theirs) {
  if (mine == null && theirs == null) return false;
  if (mine == null || theirs == null) return true;
  if (type === "number") {
    const a = Number(mine);
    const b = Number(theirs);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return String(mine) !== String(theirs);
    return Math.abs(a - b) > 0.005;
  }
  return String(mine).trim() !== String(theirs).trim();
}

async function getChannelDiff(channel) {
  await ensureSchema();
  const ch = normalizeChannel(channel);

  let locals;
  if (isEmagSot(ch)) {
    const { rows } = await query(
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
    locals = rows;
  } else {
    const { rows } = await query(
      `SELECT l.*, pf.name AS familie, c.cod_produs AS catalog_cod
       FROM marketplace_listings l
       LEFT JOIN product_families pf ON pf.id = l.id_familie
       LEFT JOIN catalog_products c ON c.id = l.product_id
       WHERE l.channel = $1
       ORDER BY CAST(NULLIF(l.external_id, '') AS BIGINT) ASC NULLS LAST`,
      [ch]
    );
    locals = rows;
  }

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
    const fields = DIFF_FIELDS.map((f) => {
      const mine =
        f.key === "min_sale_price"
          ? (l.pret_minim_override ?? l.min_sale_price ?? null)
          : (l[f.key] ?? null);
      const theirs = snap[f.key] ?? null;
      return {
        key: f.key,
        label: f.label,
        mine,
        theirs,
        differs: valuesDiffer(f.type, mine, theirs),
      };
    });
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

  const onlyRemote = [...snapByExt.values()].map((s) => ({
    external_id: s.external_id,
    part_number: s.part_number,
    name: s.name,
    sale_price: s.sale_price,
    general_stock: s.general_stock,
    fetched_at: s.fetched_at,
  }));

  const unlinked = isEmagSot(ch)
    ? locals
        .filter((l) => !l.cod_produs && !l.catalog_cod)
        .map((l) => ({
          external_id: l.external_id,
          part_number: l.part_number,
          name: l.name,
        }))
    : locals
        .filter((l) => l.product_id == null)
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

async function getChannelStats(channel) {
  await ensureSchema();
  const ch = normalizeChannel(channel);
  let listingsCount = 0;
  if (isEmagSot(ch)) {
    const { rows } = await query(
      "SELECT COUNT(*)::int AS n FROM catalog_products WHERE emag_offer_id IS NOT NULL"
    );
    listingsCount = rows[0]?.n ?? 0;
  } else {
    const { rows } = await query(
      "SELECT COUNT(*)::int AS n FROM marketplace_listings WHERE channel = $1",
      [ch]
    );
    listingsCount = rows[0]?.n ?? 0;
  }
  const meta = getCacheMeta(ch);
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
    alte_costuri: row.alte_costuri ?? null,
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
  getChannelRemotes,
  clearChannelCache,
  upsertListingFromRemote,
  getCatalogRows,
  updateListing,
  getListing,
  getListings,
  updateProduct,
  upsertCatalogProducts,
  getChannelDiff,
  getChannelStats,
  getListingCosts,
  lookupCatalogPretCumparare,
};
