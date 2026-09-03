/**
 * Stratul multi-canal (emag, trendyol) peste Postgres.
 *
 * catalog_products     — produsele mele, independente de canal (cheia de legare = cod_produs/SKU)
 * marketplace_listings — valorile MELE per canal (ce vreau sa fie pe marketplace)
 * marketplace_snapshots — ce a raportat canalul la ultimul pull (ce e acum pe marketplace)
 */
const { query, withTransaction, ensureSchema: ensurePgSchema } = require("./pg");
const { getLastPriceChangeBulk } = require("./db");
const { htmlToText, looksLikeHtml } = require("./description-format");

const CHANNELS = ["emag", "trendyol"];

function normalizeChannel(channel) {
  const c = String(channel || "emag").trim().toLowerCase();
  return CHANNELS.includes(c) ? c : "emag";
}

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
  "familie",
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

function jsonOrNull(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (typeof v === "object") return v;
  return null;
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
  const name = toTextOrNull(remote.name);
  if (name) {
    const { rows } = await query(
      "SELECT id FROM catalog_products WHERE LOWER(nume) = LOWER($1) LIMIT 1",
      [name]
    );
    if (rows[0]) return rows[0].id;
  }
  return null;
}

async function saveSnapshot(channel, remote) {
  await ensureSchema();
  const ch = normalizeChannel(channel);
  await query(
    `INSERT INTO marketplace_snapshots
       (channel, external_id, payload_json, name, part_number, ean, brand,
        sale_price, recommended_price, min_sale_price, max_sale_price,
        general_stock, status, vat_id, currency, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (channel, external_id) DO UPDATE SET
       payload_json = EXCLUDED.payload_json,
       name = EXCLUDED.name,
       part_number = EXCLUDED.part_number,
       ean = EXCLUDED.ean,
       brand = EXCLUDED.brand,
       sale_price = EXCLUDED.sale_price,
       recommended_price = EXCLUDED.recommended_price,
       min_sale_price = EXCLUDED.min_sale_price,
       max_sale_price = EXCLUDED.max_sale_price,
       general_stock = EXCLUDED.general_stock,
       status = EXCLUDED.status,
       vat_id = EXCLUDED.vat_id,
       currency = EXCLUDED.currency,
       fetched_at = EXCLUDED.fetched_at`,
    [
      ch,
      String(remote.id),
      jsonOrNull(remote),
      toTextOrNull(remote.name),
      toTextOrNull(remote.part_number),
      toTextOrNull(remote.ean),
      toTextOrNull(remote.brand),
      toNumOrNull(remote.sale_price),
      toNumOrNull(remote.recommended_price),
      toNumOrNull(remote.min_sale_price),
      toNumOrNull(remote.max_sale_price),
      toNumOrNull(remote.general_stock),
      toNumOrNull(remote.status),
      toNumOrNull(remote.vat_id),
      toTextOrNull(remote.currency),
      new Date().toISOString(),
    ]
  );
}

async function upsertListingFromRemote(channel, remote) {
  await ensureSchema();
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
    familie: toTextOrNull(remote.familie),
    characteristics: toTextOrNull(remote.characteristics),
    estimated_stock: toNumOrNull(remote.estimated_stock),
    handling_time_json: jsonOrNull(remote.handling_time),
    status: toNumOrNull(remote.status),
    vat_id: toNumOrNull(remote.vat_id),
    currency: toTextOrNull(remote.currency),
  };

  if (!existing) {
    await query(
      `INSERT INTO marketplace_listings
         (channel, external_id, product_id, part_number, part_number_key, name, description,
          brand, ean, id_familie, familie, characteristics,
          sale_price, recommended_price, min_sale_price, max_sale_price,
          general_stock, estimated_stock, stock_json, handling_time_json,
          status, vat_id, currency, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
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
        channelValues.familie,
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

async function getCatalogRows(channel) {
  await ensureSchema();
  const ch = normalizeChannel(channel);
  const { rows } = await query(
    `SELECT l.*, c.pret_cumparare AS catalog_pret_cumparare, c.cod_produs AS catalog_cod
     FROM marketplace_listings l
     LEFT JOIN catalog_products c ON c.id = l.product_id
     WHERE l.channel = $1
     ORDER BY CAST(NULLIF(l.external_id, '') AS BIGINT) ASC NULLS LAST`,
    [ch]
  );

  const products = rows.map((r) => ({
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
  }));

  const lastChanges = await getLastPriceChangeBulk(products.map((p) => p.id));
  for (const p of products) {
    const lc = lastChanges[p.id];
    p.pret_emag_last_change = lc ? lc.recorded_at : null;
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

async function setListingPretCumparare(channel, externalId, value) {
  await ensureSchema();
  const listing = await getListing(channel, externalId);
  if (!listing) throw new Error("Listing inexistent");

  const price = toNumOrNull(value);
  const now = new Date().toISOString();
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

async function updateListing(channel, externalId, fields) {
  await ensureSchema();
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
    payload.stock_json = fields.stock;
    payload.general_stock = fields.stock.reduce(
      (sum, s) => sum + (Number(s?.value) || 0),
      0
    );
  }
  if (Array.isArray(fields.handling_time)) {
    payload.handling_time_json = fields.handling_time;
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

async function getListing(channel, externalId) {
  await ensureSchema();
  const { rows } = await query(
    "SELECT * FROM marketplace_listings WHERE channel = $1 AND external_id = $2",
    [normalizeChannel(channel), String(externalId)]
  );
  return rows[0] || null;
}

async function getListings(channel, externalIds) {
  await ensureSchema();
  const ch = normalizeChannel(channel);
  const ids = [...new Set((externalIds || []).map((v) => String(v)).filter(Boolean))];
  if (ids.length === 0) return [];
  const { rows } = await query(
    `SELECT * FROM marketplace_listings
     WHERE channel = $1 AND external_id = ANY($2::text[])`,
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
  const keys = Object.keys(payload);
  if (keys.length > 0) {
    const params = [];
    const sets = keys.map((k) => {
      params.push(payload[k]);
      return `${k} = $${params.length}`;
    });
    params.push(new Date().toISOString(), id);
    await query(
      `UPDATE catalog_products SET ${sets.join(", ")}, updated_at = $${params.length - 1} WHERE id = $${params.length}`,
      params
    );
  }
  const { rows } = await query("SELECT * FROM catalog_products WHERE id = $1", [id]);
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

  const { rows: listings } = await query(
    `SELECT l.*, c.cod_produs AS catalog_cod
     FROM marketplace_listings l
     LEFT JOIN catalog_products c ON c.id = l.product_id
     WHERE l.channel = $1
     ORDER BY CAST(NULLIF(l.external_id, '') AS BIGINT) ASC NULLS LAST`,
    [ch]
  );
  const { rows: snapshots } = await query(
    "SELECT * FROM marketplace_snapshots WHERE channel = $1",
    [ch]
  );

  const snapByExt = new Map(snapshots.map((s) => [String(s.external_id), s]));
  const matched = [];
  const onlyLocal = [];

  for (const l of listings) {
    const snap = snapByExt.get(String(l.external_id));
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
    snapByExt.delete(String(l.external_id));
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

  const unlinked = listings
    .filter((l) => l.product_id == null)
    .map((l) => ({
      external_id: l.external_id,
      part_number: l.part_number,
      name: l.name,
    }));

  const stats = await getChannelStats(ch);
  return {
    channel: ch,
    last_sync: stats.last_sync,
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
  const { rows: listingRows } = await query(
    "SELECT COUNT(*)::int AS n FROM marketplace_listings WHERE channel = $1",
    [ch]
  );
  const { rows: snapRows } = await query(
    "SELECT COUNT(*)::int AS n, MAX(fetched_at) AS last FROM marketplace_snapshots WHERE channel = $1",
    [ch]
  );
  return {
    channel: ch,
    listings: listingRows[0]?.n ?? 0,
    snapshots: snapRows[0]?.n ?? 0,
    last_sync: snapRows[0]?.last ?? null,
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
  saveSnapshot,
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
