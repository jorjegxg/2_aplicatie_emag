/**
 * Stratul multi-canal (emag, trendyol) peste SQLite.
 *
 * catalog_products     — produsele mele, independente de canal (cheia de legare = cod_produs/SKU)
 * marketplace_listings — valorile MELE per canal (ce vreau sa fie pe marketplace)
 * marketplace_snapshots — ce a raportat canalul la ultimul pull (ce e acum pe marketplace)
 */
const { getDb, getLastPriceChangeBulk } = require("./db");
const { htmlToText, looksLikeHtml } = require("./description-format");

const CHANNELS = ["emag", "trendyol"];

function normalizeChannel(channel) {
  const c = String(channel || "emag").trim().toLowerCase();
  return CHANNELS.includes(c) ? c : "emag";
}

// Campurile mele: pull-ul le completeaza doar cand sunt NULL (listing nou sau migrat gol),
// niciodata peste o valoare pe care am pus-o eu.
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

// Campuri detinute de canal — se rescriu la fiecare pull.
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

// Descrierea se pastreaza ca text curat; daca ajunge HTML (lipit in UI) il curatam la scriere.
function toPlainTextOrNull(v) {
  if (v == null) return null;
  const s = looksLikeHtml(v) ? htmlToText(v) : String(v);
  return s === "" ? null : s;
}

function jsonOrNull(v) {
  if (v == null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function parseJson(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/* ---------------- schema + migrari ---------------- */

let schemaReady = false;

function db() {
  const database = getDb();
  if (!schemaReady) {
    ensureSchema(database);
    schemaReady = true;
  }
  return database;
}

function ensureSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS catalog_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cod_produs TEXT UNIQUE COLLATE NOCASE,
      nume TEXT,
      descriere TEXT,
      brand TEXT,
      ean TEXT,
      pret_cumparare REAL,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_catalog_nume
      ON catalog_products(nume COLLATE NOCASE);
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      product_id INTEGER REFERENCES catalog_products(id),
      part_number TEXT,
      part_number_key TEXT,
      name TEXT,
      description TEXT,
      brand TEXT,
      ean TEXT,
      id_familie INTEGER,
      familie TEXT,
      characteristics TEXT,
      sale_price REAL,
      recommended_price REAL,
      min_sale_price REAL,
      max_sale_price REAL,
      general_stock REAL,
      estimated_stock REAL,
      stock_json TEXT,
      handling_time_json TEXT,
      status INTEGER,
      vat_id INTEGER,
      currency TEXT,
      alte_costuri REAL,
      pret_minim_override REAL,
      procentaj_emag REAL,
      commission_value REAL,
      commission_fetched_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(channel, external_id)
    );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_listings_product
      ON marketplace_listings(product_id);
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_snapshots (
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      payload_json TEXT,
      name TEXT,
      part_number TEXT,
      ean TEXT,
      brand TEXT,
      sale_price REAL,
      recommended_price REAL,
      min_sale_price REAL,
      max_sale_price REAL,
      general_stock REAL,
      status INTEGER,
      vat_id INTEGER,
      currency TEXT,
      fetched_at TEXT,
      PRIMARY KEY (channel, external_id)
    );
  `);

  const histCols = new Set(
    database
      .prepare("PRAGMA table_info(product_pret_emag_history)")
      .all()
      .map((c) => c.name)
  );
  if (!histCols.has("channel")) {
    database.exec(
      "ALTER TABLE product_pret_emag_history ADD COLUMN channel TEXT DEFAULT 'emag'"
    );
  }

  runMigration(database, "catalog-from-products", () => {
    let hasProducts = false;
    try {
      database.prepare("SELECT 1 FROM products LIMIT 1").get();
      hasProducts = true;
    } catch {
      hasProducts = false;
    }
    if (!hasProducts) return;
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT OR IGNORE INTO catalog_products (cod_produs, nume, pret_cumparare, created_at, updated_at)
         SELECT cod_produs, nume_produs, pret_cumparare, ?, ? FROM products`
      )
      .run(now, now);
  });

  runMigration(database, "listings-from-legacy-overrides", () => {
    const ids = database
      .prepare(
        `SELECT offer_id FROM product_alte_costuri
         UNION SELECT offer_id FROM product_pret_minim
         UNION SELECT offer_id FROM product_procentaj_emag`
      )
      .all()
      .map((r) => String(r.offer_id));
    if (ids.length === 0) return;

    const now = new Date().toISOString();
    const insert = database.prepare(
      `INSERT OR IGNORE INTO marketplace_listings (channel, external_id, created_at, updated_at)
       VALUES ('emag', ?, ?, ?)`
    );
    const update = database.prepare(
      `UPDATE marketplace_listings SET
         alte_costuri = (SELECT alte_costuri FROM product_alte_costuri WHERE offer_id = @id),
         pret_minim_override = (SELECT pret_minim FROM product_pret_minim WHERE offer_id = @id),
         procentaj_emag = (SELECT procentaj_emag FROM product_procentaj_emag WHERE offer_id = @id),
         commission_value = (SELECT commission_value FROM product_procentaj_emag WHERE offer_id = @id),
         commission_fetched_at = (SELECT fetched_at FROM product_procentaj_emag WHERE offer_id = @id),
         updated_at = @now
       WHERE channel = 'emag' AND external_id = @ext`
    );
    for (const id of ids) {
      insert.run(id, now, now);
      update.run({ id: Number(id), ext: id, now });
    }
  });

  runMigration(database, "description-plain-text", () => {
    const rewrite = (table, column) => {
      const rows = database
        .prepare(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`)
        .all();
      const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
      for (const row of rows) {
        if (!looksLikeHtml(row.value)) continue;
        update.run(htmlToText(row.value) || null, row.id);
      }
    };
    rewrite("marketplace_listings", "description");
    rewrite("catalog_products", "descriere");
  });

  runMigration(database, "description-decode-remaining-entities", () => {
    const rewrite = (table, column) => {
      const rows = database
        .prepare(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`)
        .all();
      const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
      for (const row of rows) {
        if (!looksLikeHtml(row.value)) continue;
        update.run(htmlToText(row.value) || null, row.id);
      }
    };
    rewrite("marketplace_listings", "description");
    rewrite("catalog_products", "descriere");
  });

  runMigration(database, "drop-pret-contabil", () => {
    const hasCol = (table, col) =>
      database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => c.name === col);
    if (hasCol("marketplace_listings", "pret_contabil")) {
      database.exec("ALTER TABLE marketplace_listings DROP COLUMN pret_contabil");
    }
    if (hasCol("settings", "pret_contabil")) {
      database.exec("ALTER TABLE settings DROP COLUMN pret_contabil");
    }
    if (hasCol("settings", "procentaj_pret_contabil")) {
      database.exec("ALTER TABLE settings DROP COLUMN procentaj_pret_contabil");
    }
    database.exec("DROP TABLE IF EXISTS product_pret_contabil");
  });
}

function runMigration(database, key, fn) {
  const metaKey = `migration:${key}`;
  const done = database.prepare("SELECT value FROM app_meta WHERE key = ?").get(metaKey);
  if (done) return;
  try {
    database.transaction(fn)();
  } catch (err) {
    console.warn(`[migrare ${key}] ${err.message}`);
    return;
  }
  database
    .prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)")
    .run(metaKey, new Date().toISOString());
}

/* ---------------- legare catalog ---------------- */

/** Intai dupa SKU, apoi dupa EAN, apoi dupa nume exact. */
function findCatalogProductId(remote) {
  const database = db();
  const sku = toTextOrNull(remote.part_number);
  if (sku) {
    const row = database
      .prepare("SELECT id FROM catalog_products WHERE cod_produs = ? COLLATE NOCASE LIMIT 1")
      .get(sku);
    if (row) return row.id;
  }
  const ean = toTextOrNull(remote.ean);
  if (ean) {
    const first = ean.split(",")[0].trim();
    if (first) {
      const row = database
        .prepare("SELECT id FROM catalog_products WHERE ean = ? COLLATE NOCASE LIMIT 1")
        .get(first);
      if (row) return row.id;
    }
  }
  const name = toTextOrNull(remote.name);
  if (name) {
    const row = database
      .prepare("SELECT id FROM catalog_products WHERE nume = ? COLLATE NOCASE LIMIT 1")
      .get(name);
    if (row) return row.id;
  }
  return null;
}

/* ---------------- snapshots ---------------- */

function saveSnapshot(channel, remote) {
  const ch = normalizeChannel(channel);
  db()
    .prepare(
      `INSERT INTO marketplace_snapshots
         (channel, external_id, payload_json, name, part_number, ean, brand,
          sale_price, recommended_price, min_sale_price, max_sale_price,
          general_stock, status, vat_id, currency, fetched_at)
       VALUES (@channel, @external_id, @payload_json, @name, @part_number, @ean, @brand,
          @sale_price, @recommended_price, @min_sale_price, @max_sale_price,
          @general_stock, @status, @vat_id, @currency, @fetched_at)
       ON CONFLICT(channel, external_id) DO UPDATE SET
         payload_json = excluded.payload_json,
         name = excluded.name,
         part_number = excluded.part_number,
         ean = excluded.ean,
         brand = excluded.brand,
         sale_price = excluded.sale_price,
         recommended_price = excluded.recommended_price,
         min_sale_price = excluded.min_sale_price,
         max_sale_price = excluded.max_sale_price,
         general_stock = excluded.general_stock,
         status = excluded.status,
         vat_id = excluded.vat_id,
         currency = excluded.currency,
         fetched_at = excluded.fetched_at`
    )
    .run({
      channel: ch,
      external_id: String(remote.id),
      payload_json: jsonOrNull(remote),
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
      fetched_at: new Date().toISOString(),
    });
}

/**
 * Listing nou = seed complet cu valorile remote.
 * Listing existent = doar campurile detinute de canal; valorile mele
 * (pret, stoc, nume, descriere, costuri) raman neatinse.
 */
function upsertListingFromRemote(channel, remote) {
  const database = db();
  const ch = normalizeChannel(channel);
  const ext = String(remote.id);
  const now = new Date().toISOString();

  const existing = database
    .prepare(
      "SELECT id, product_id FROM marketplace_listings WHERE channel = ? AND external_id = ?"
    )
    .get(ch, ext);

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
    database
      .prepare(
        `INSERT INTO marketplace_listings
           (channel, external_id, product_id, part_number, part_number_key, name, description,
            brand, ean, id_familie, familie, characteristics,
            sale_price, recommended_price, min_sale_price, max_sale_price,
            general_stock, estimated_stock, stock_json, handling_time_json,
            status, vat_id, currency, created_at, updated_at)
         VALUES
           (@channel, @external_id, @product_id, @part_number, @part_number_key, @name, @description,
            @brand, @ean, @id_familie, @familie, @characteristics,
            @sale_price, @recommended_price, @min_sale_price, @max_sale_price,
            @general_stock, @estimated_stock, @stock_json, @handling_time_json,
            @status, @vat_id, @currency, @created_at, @updated_at)`
      )
      .run({
        channel: ch,
        external_id: ext,
        product_id: findCatalogProductId(remote),
        ...channelValues,
        name: toTextOrNull(remote.name),
        description: toTextOrNull(remote.description),
        sale_price: toNumOrNull(remote.sale_price),
        recommended_price: toNumOrNull(remote.recommended_price),
        min_sale_price: toNumOrNull(remote.min_sale_price),
        max_sale_price: toNumOrNull(remote.max_sale_price),
        general_stock: toNumOrNull(remote.general_stock),
        stock_json: jsonOrNull(remote.stock),
        created_at: now,
        updated_at: now,
      });
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

  const sets = [
    ...CHANNEL_OWNED_FIELDS.map((f) => `${f} = @${f}`),
    ...LOCAL_SEED_FIELDS.map((f) => `${f} = COALESCE(${f}, @${f})`),
  ].join(", ");
  database
    .prepare(
      `UPDATE marketplace_listings SET ${sets}, updated_at = @updated_at
       WHERE channel = @channel AND external_id = @external_id`
    )
    .run({
      ...channelValues,
      ...seedValues,
      channel: ch,
      external_id: ext,
      updated_at: now,
    });

  if (existing.product_id == null) {
    const productId = findCatalogProductId(remote);
    if (productId != null) {
      database
        .prepare("UPDATE marketplace_listings SET product_id = ? WHERE id = ?")
        .run(productId, existing.id);
    }
  }
  return { created: false };
}

/* ---------------- citire tabel principal ---------------- */

/** Randurile pentru tabelul principal — aceeasi forma pe care o consuma public/app.js. */
function getCatalogRows(channel) {
  const ch = normalizeChannel(channel);
  const rows = db()
    .prepare(
      `SELECT l.*, c.pret_cumparare AS catalog_pret_cumparare, c.cod_produs AS catalog_cod
       FROM marketplace_listings l
       LEFT JOIN catalog_products c ON c.id = l.product_id
       WHERE l.channel = ?
       ORDER BY CAST(l.external_id AS INTEGER) ASC`
    )
    .all(ch);

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
    sale_price: r.sale_price ?? null,
    recommended_price: r.recommended_price ?? null,
    min_sale_price: r.min_sale_price ?? null,
    max_sale_price: r.max_sale_price ?? null,
    pret_cumparare: r.catalog_pret_cumparare ?? null,
    alte_costuri: r.alte_costuri ?? null,
    pret_minim_override: r.pret_minim_override ?? null,
    procentaj_emag: r.procentaj_emag ?? null,
    commission_value: r.commission_value ?? null,
    commission_fetched_at: r.commission_fetched_at ?? null,
    currency: r.currency || "RON",
    general_stock: r.general_stock ?? null,
    estimated_stock: r.estimated_stock ?? null,
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

  const lastChanges = getLastPriceChangeBulk(products.map((p) => p.id));
  for (const p of products) {
    const lc = lastChanges[p.id];
    p.pret_emag_last_change = lc ? lc.recorded_at : null;
  }
  return products;
}

/* ---------------- scriere ---------------- */

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
  commission_fetched_at: toTextOrNull,
  status: toNumOrNull,
  vat_id: toNumOrNull,
};

/** Scrie pretul de cumparare pe produsul de catalog legat de listing (il creeaza daca lipseste). */
function setListingPretCumparare(channel, externalId, value) {
  const database = db();
  const listing = getListing(channel, externalId);
  if (!listing) throw new Error("Listing inexistent");

  const price = toNumOrNull(value);
  const now = new Date().toISOString();
  let productId = listing.product_id;

  if (productId == null) {
    productId = findCatalogProductId(listing);
    if (productId == null) {
      const cod = toTextOrNull(listing.part_number);
      const nume = toTextOrNull(listing.name) || cod;
      const info = database
        .prepare(
          `INSERT INTO catalog_products (cod_produs, nume, pret_cumparare, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(cod, nume, price, now, now);
      productId = Number(info.lastInsertRowid);
    }
    database
      .prepare("UPDATE marketplace_listings SET product_id = ?, updated_at = ? WHERE id = ?")
      .run(productId, now, listing.id);
  }

  database
    .prepare("UPDATE catalog_products SET pret_cumparare = ?, updated_at = ? WHERE id = ?")
    .run(price, now, productId);
  return productId;
}

/** Salveaza un subset de campuri pe un listing. `stock` (array) actualizeaza si general_stock. */
function updateListing(channel, externalId, fields) {
  const database = db();
  const ch = normalizeChannel(channel);
  const ext = String(externalId ?? "").trim();
  if (!ext) throw new Error("external_id invalid");

  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT OR IGNORE INTO marketplace_listings (channel, external_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(ch, ext, now, now);

  if (Object.prototype.hasOwnProperty.call(fields, "pret_cumparare")) {
    setListingPretCumparare(ch, ext, fields.pret_cumparare);
  }

  const payload = {};
  for (const [key, coerce] of Object.entries(LISTING_EDITABLE)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      payload[key] = coerce(fields[key]);
    }
  }
  if (Array.isArray(fields.stock)) {
    payload.stock_json = JSON.stringify(fields.stock);
    payload.general_stock = fields.stock.reduce(
      (sum, s) => sum + (Number(s?.value) || 0),
      0
    );
  }
  if (Array.isArray(fields.handling_time)) {
    payload.handling_time_json = JSON.stringify(fields.handling_time);
  }

  const keys = Object.keys(payload);
  if (keys.length === 0) return getListing(ch, ext);

  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  database
    .prepare(
      `UPDATE marketplace_listings SET ${sets}, updated_at = @updated_at
       WHERE channel = @channel AND external_id = @external_id`
    )
    .run({ ...payload, channel: ch, external_id: ext, updated_at: now });

  return getListing(ch, ext);
}

function getListing(channel, externalId) {
  return db()
    .prepare("SELECT * FROM marketplace_listings WHERE channel = ? AND external_id = ?")
    .get(normalizeChannel(channel), String(externalId));
}

function getListings(channel, externalIds) {
  const ch = normalizeChannel(channel);
  const ids = [...new Set((externalIds || []).map((v) => String(v)).filter(Boolean))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db()
    .prepare(
      `SELECT * FROM marketplace_listings
       WHERE channel = ? AND external_id IN (${placeholders})`
    )
    .all(ch, ...ids);
}

const PRODUCT_EDITABLE = {
  cod_produs: toTextOrNull,
  nume: toTextOrNull,
  descriere: toPlainTextOrNull,
  brand: toTextOrNull,
  ean: toTextOrNull,
  pret_cumparare: toNumOrNull,
};

function updateProduct(productId, fields) {
  const database = db();
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
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    database
      .prepare(`UPDATE catalog_products SET ${sets}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...payload, id, updated_at: new Date().toISOString() });
  }
  return database.prepare("SELECT * FROM catalog_products WHERE id = ?").get(id);
}

function upsertCatalogProducts(items) {
  const database = db();
  const now = new Date().toISOString();
  const withCod = database.prepare(
    `INSERT INTO catalog_products (cod_produs, nume, pret_cumparare, created_at, updated_at)
     VALUES (@cod_produs, @nume, @pret_cumparare, @now, @now)
     ON CONFLICT(cod_produs) DO UPDATE SET
       nume = excluded.nume,
       pret_cumparare = excluded.pret_cumparare,
       updated_at = excluded.updated_at`
  );
  const noCod = database.prepare(
    `INSERT INTO catalog_products (cod_produs, nume, pret_cumparare, created_at, updated_at)
     VALUES (NULL, @nume, @pret_cumparare, @now, @now)`
  );
  const run = database.transaction((rows) => {
    let count = 0;
    for (const r of rows) {
      const cod = toTextOrNull(r?.cod_produs);
      const nume = toTextOrNull(r?.nume) || cod;
      if (!cod && !nume) continue;
      const payload = {
        cod_produs: cod,
        nume,
        pret_cumparare: toNumOrNull(r?.pret_cumparare),
        now,
      };
      if (cod) withCod.run(payload);
      else noCod.run(payload);
      count += 1;
    }
    return count;
  });
  return run(Array.isArray(items) ? items : []);
}

/* ---------------- diff local vs canal ---------------- */

const DIFF_FIELDS = [
  { key: "sale_price", label: "Preț vânzare", type: "number" },
  { key: "recommended_price", label: "PRP", type: "number" },
  { key: "min_sale_price", label: "Preț minim", type: "number" },
  { key: "max_sale_price", label: "Preț maxim", type: "number" },
  { key: "general_stock", label: "Stoc", type: "number" },
  // status/vat_id/currency sunt in CHANNEL_OWNED_FIELDS: pull-ul le rescrie mereu,
  // deci nu pot diferi niciodata. Nu au ce cauta in comparatie.
  // name nu e aici: push trimite doar pret/stoc; pull nu rescrie numele (LOCAL_SEED).
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

/** Comparatie listing local vs ultimul snapshot al canalului. */
function getChannelDiff(channel) {
  const database = db();
  const ch = normalizeChannel(channel);

  const listings = database
    .prepare(
      `SELECT l.*, c.cod_produs AS catalog_cod
       FROM marketplace_listings l
       LEFT JOIN catalog_products c ON c.id = l.product_id
       WHERE l.channel = ?
       ORDER BY CAST(l.external_id AS INTEGER) ASC`
    )
    .all(ch);
  const snapshots = database
    .prepare("SELECT * FROM marketplace_snapshots WHERE channel = ?")
    .all(ch);

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
      // UI + push folosesc override ?? min_sale_price — comparatia la fel.
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

  return {
    channel: ch,
    last_sync: getChannelStats(ch).last_sync,
    fields: DIFF_FIELDS,
    matched,
    only_local: onlyLocal,
    only_remote: onlyRemote,
    unlinked,
  };
}

function getChannelStats(channel) {
  const ch = normalizeChannel(channel);
  const database = db();
  const listings = database
    .prepare("SELECT COUNT(*) AS n FROM marketplace_listings WHERE channel = ?")
    .get(ch);
  const snaps = database
    .prepare(
      "SELECT COUNT(*) AS n, MAX(fetched_at) AS last FROM marketplace_snapshots WHERE channel = ?"
    )
    .get(ch);
  return {
    channel: ch,
    listings: listings?.n ?? 0,
    snapshots: snaps?.n ?? 0,
    last_sync: snaps?.last ?? null,
  };
}

/** Costurile mele pentru o oferta — inlocuieste tabelele legacy per-offer. */
function getListingCosts(channel, externalId) {
  const row = getListing(channel, externalId);
  if (!row) return null;
  return {
    alte_costuri: row.alte_costuri ?? null,
    procentaj_emag: row.procentaj_emag ?? null,
    commission_value: row.commission_value ?? null,
    commission_fetched_at: row.commission_fetched_at ?? null,
  };
}

/** Pret cumparare din catalog: intai dupa SKU, apoi dupa nume. */
function lookupCatalogPretCumparare(partNumber, name) {
  const database = db();
  const cod = toTextOrNull(partNumber);
  if (cod) {
    const row = database
      .prepare('SELECT pret_cumparare FROM catalog_products WHERE cod_produs = ? COLLATE NOCASE LIMIT 1')
      .get(cod);
    if (row && row.pret_cumparare != null) return row.pret_cumparare;
  }
  const nume = toTextOrNull(name);
  if (nume) {
    const row = database
      .prepare('SELECT pret_cumparare FROM catalog_products WHERE nume = ? COLLATE NOCASE LIMIT 1')
      .get(nume);
    if (row && row.pret_cumparare != null) return row.pret_cumparare;
  }
  return null;
}

module.exports = {
  CHANNELS,
  normalizeChannel,
  ensureSchema: () => db(),
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
