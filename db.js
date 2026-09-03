const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "data", "products.db");

let db = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pret_transport REAL,
      pret_contabil REAL,
      procentaj_emag REAL,
      numar_produse REAL,
      mult_prp REAL,
      mult_min REAL,
      mult_max REAL
    );
  `);
  const cols = db.prepare("PRAGMA table_info(settings)").all();
  const colNames = new Set(cols.map((c) => c.name));
  for (const name of [
    "numar_produse",
    "mult_prp",
    "mult_min",
    "mult_max",
    "alte_costuri",
    "procentaj_alte_costuri",
    "procentaj_pret_contabil",
  ]) {
    if (!colNames.has(name)) {
      db.exec(`ALTER TABLE settings ADD COLUMN ${name} REAL`);
    }
  }
  db.exec(`
    INSERT OR IGNORE INTO settings (id, pret_transport, pret_contabil, procentaj_emag, numar_produse, mult_prp, mult_min, mult_max, alte_costuri)
    VALUES (1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  `);
  db.exec(`
    UPDATE settings
    SET alte_costuri = COALESCE(pret_transport, 0) + COALESCE(pret_contabil, 0)
    WHERE id = 1
      AND alte_costuri IS NULL
      AND (pret_transport IS NOT NULL OR pret_contabil IS NOT NULL);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_alte_costuri (
      offer_id INTEGER PRIMARY KEY,
      alte_costuri REAL NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_pret_contabil (
      offer_id INTEGER PRIMARY KEY,
      pret_contabil REAL NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_pret_minim (
      offer_id INTEGER PRIMARY KEY,
      pret_minim REAL NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_procentaj_emag (
      offer_id INTEGER PRIMARY KEY,
      procentaj_emag REAL NOT NULL,
      commission_value REAL,
      fetched_at TEXT
    );
  `);
  const pctCols = getDb().prepare("PRAGMA table_info(product_procentaj_emag)").all();
  const pctColNames = new Set(pctCols.map((c) => c.name));
  for (const name of ["commission_value", "fetched_at"]) {
    if (!pctColNames.has(name)) {
      getDb().exec(
        `ALTER TABLE product_procentaj_emag ADD COLUMN ${name} ${
          name === "fetched_at" ? "TEXT" : "REAL"
        }`
      );
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_pret_emag_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER NOT NULL,
      sale_price REAL NOT NULL,
      currency TEXT,
      recorded_at TEXT NOT NULL,
      source TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pret_emag_hist_offer
      ON product_pret_emag_history(offer_id, recorded_at);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_line_history (
      line_id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL,
      product_id INTEGER,
      part_number TEXT,
      name TEXT,
      quantity REAL,
      sale_price REAL,
      status INTEGER,
      currency TEXT,
      order_date TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_order_line_product
      ON order_line_history(product_id, order_date);
  `);
  return db;
}

function lookupPretCumparare(partNumber, name) {
  const database = getDb();

  const cod = String(partNumber ?? "").trim();
  if (cod) {
    try {
      const byCod = database
        .prepare(
          "SELECT pret_cumparare FROM products WHERE cod_produs = ? COLLATE NOCASE LIMIT 1"
        )
        .get(cod);
      if (byCod && byCod.pret_cumparare != null) {
        return byCod.pret_cumparare;
      }
    } catch {
      /* products table may not exist yet */
    }
  }

  const nume = String(name ?? "").trim();
  if (nume) {
    try {
      const byNume = database
        .prepare(
          "SELECT pret_cumparare FROM products WHERE nume_produs = ? COLLATE NOCASE LIMIT 1"
        )
        .get(nume);
      if (byNume && byNume.pret_cumparare != null) {
        return byNume.pret_cumparare;
      }
    } catch {
      /* products table may not exist yet */
    }
  }

  return null;
}

function getSettings() {
  const row = getDb()
    .prepare(
      `SELECT procentaj_emag, procentaj_alte_costuri, procentaj_pret_contabil,
              mult_prp, mult_min, mult_max
       FROM settings WHERE id = 1`
    )
    .get();
  return {
    procentaj_emag: row?.procentaj_emag ?? null,
    procentaj_alte_costuri: row?.procentaj_alte_costuri ?? null,
    procentaj_pret_contabil: row?.procentaj_pret_contabil ?? null,
    mult_prp: row?.mult_prp ?? null,
    mult_min: row?.mult_min ?? null,
    mult_max: row?.mult_max ?? null,
  };
}

function saveSettings({
  procentaj_alte_costuri,
  procentaj_pret_contabil,
  mult_prp,
  mult_min,
  mult_max,
}) {
  getDb()
    .prepare(
      `UPDATE settings
       SET procentaj_alte_costuri = @procentaj_alte_costuri,
           procentaj_pret_contabil = @procentaj_pret_contabil,
           mult_prp = @mult_prp,
           mult_min = @mult_min,
           mult_max = @mult_max
       WHERE id = 1`
    )
    .run({
      procentaj_alte_costuri,
      procentaj_pret_contabil,
      mult_prp,
      mult_min,
      mult_max,
    });
  return getSettings();
}

function lookupAlteCosturi(offerId) {
  const id = Number(offerId);
  if (!Number.isFinite(id)) return null;
  try {
    const row = getDb()
      .prepare(
        "SELECT alte_costuri FROM product_alte_costuri WHERE offer_id = ? LIMIT 1"
      )
      .get(id);
    if (row == null || row.alte_costuri == null) return null;
    const n = Number(row.alte_costuri);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function lookupAlteCosturiBulk(offerIds) {
  const ids = [
    ...new Set(
      (Array.isArray(offerIds) ? offerIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id))
    ),
  ];
  if (ids.length === 0) return {};

  try {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = getDb()
      .prepare(
        `SELECT offer_id, alte_costuri
         FROM product_alte_costuri WHERE offer_id IN (${placeholders})`
      )
      .all(...ids);

    const out = {};
    for (const row of rows) {
      if (row.alte_costuri == null) continue;
      const n = Number(row.alte_costuri);
      if (!Number.isFinite(n)) continue;
      out[row.offer_id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function saveAlteCosturi(offerId, value) {
  const id = Number(offerId);
  const n = Number(value);
  if (!Number.isFinite(id) || !Number.isFinite(n)) {
    throw new Error("id și alte_costuri trebuie să fie numere");
  }
  getDb()
    .prepare(
      `INSERT INTO product_alte_costuri (offer_id, alte_costuri)
       VALUES (@offer_id, @alte_costuri)
       ON CONFLICT(offer_id) DO UPDATE SET alte_costuri = excluded.alte_costuri`
    )
    .run({ offer_id: id, alte_costuri: n });
  return n;
}

function clearAlteCosturi(offerId) {
  const id = Number(offerId);
  if (!Number.isFinite(id)) {
    throw new Error("id invalid");
  }
  getDb()
    .prepare("DELETE FROM product_alte_costuri WHERE offer_id = ?")
    .run(id);
  return null;
}

function lookupPretContabil(offerId) {
  const id = Number(offerId);
  if (!Number.isFinite(id)) return null;
  try {
    const row = getDb()
      .prepare(
        "SELECT pret_contabil FROM product_pret_contabil WHERE offer_id = ? LIMIT 1"
      )
      .get(id);
    if (row == null || row.pret_contabil == null) return null;
    const n = Number(row.pret_contabil);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function lookupPretContabilBulk(offerIds) {
  const ids = [
    ...new Set(
      (Array.isArray(offerIds) ? offerIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id))
    ),
  ];
  if (ids.length === 0) return {};

  try {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = getDb()
      .prepare(
        `SELECT offer_id, pret_contabil
         FROM product_pret_contabil WHERE offer_id IN (${placeholders})`
      )
      .all(...ids);

    const out = {};
    for (const row of rows) {
      if (row.pret_contabil == null) continue;
      const n = Number(row.pret_contabil);
      if (!Number.isFinite(n)) continue;
      out[row.offer_id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function lookupCostOverridesBulk(offerIds) {
  const ids = [
    ...new Set(
      (Array.isArray(offerIds) ? offerIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id))
    ),
  ];
  if (ids.length === 0) return {};

  const alte = lookupAlteCosturiBulk(ids);
  const contabil = lookupPretContabilBulk(ids);
  const out = {};
  for (const id of ids) {
    out[id] = {
      alte_costuri: alte[id] ?? null,
      pret_contabil: contabil[id] ?? null,
    };
  }
  return out;
}

function savePretContabil(offerId, value) {
  const id = Number(offerId);
  const n = Number(value);
  if (!Number.isFinite(id) || !Number.isFinite(n)) {
    throw new Error("id și pret_contabil trebuie să fie numere");
  }
  getDb()
    .prepare(
      `INSERT INTO product_pret_contabil (offer_id, pret_contabil)
       VALUES (@offer_id, @pret_contabil)
       ON CONFLICT(offer_id) DO UPDATE SET pret_contabil = excluded.pret_contabil`
    )
    .run({ offer_id: id, pret_contabil: n });
  return n;
}

function clearPretContabil(offerId) {
  const id = Number(offerId);
  if (!Number.isFinite(id)) {
    throw new Error("id invalid");
  }
  getDb()
    .prepare("DELETE FROM product_pret_contabil WHERE offer_id = ?")
    .run(id);
  return null;
}

function lookupPretMinim(offerId) {
  const id = Number(offerId);
  if (!Number.isFinite(id)) return null;
  try {
    const row = getDb()
      .prepare(
        "SELECT pret_minim FROM product_pret_minim WHERE offer_id = ? LIMIT 1"
      )
      .get(id);
    if (row == null || row.pret_minim == null) return null;
    const n = Number(row.pret_minim);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function savePretMinim(offerId, value) {
  const id = Number(offerId);
  const n = Number(value);
  if (!Number.isFinite(id) || !Number.isFinite(n)) {
    throw new Error("id și pret_minim trebuie să fie numere");
  }
  getDb()
    .prepare(
      `INSERT INTO product_pret_minim (offer_id, pret_minim)
       VALUES (@offer_id, @pret_minim)
       ON CONFLICT(offer_id) DO UPDATE SET pret_minim = excluded.pret_minim`
    )
    .run({ offer_id: id, pret_minim: n });
  return n;
}

function clearPretMinim(offerId) {
  const id = Number(offerId);
  if (!Number.isFinite(id)) {
    throw new Error("id invalid");
  }
  getDb()
    .prepare("DELETE FROM product_pret_minim WHERE offer_id = ?")
    .run(id);
  return null;
}

function lookupCommission(offerId) {
  const id = Number(offerId);
  if (!Number.isFinite(id)) return null;
  try {
    const row = getDb()
      .prepare(
        `SELECT procentaj_emag, commission_value, fetched_at
         FROM product_procentaj_emag WHERE offer_id = ? LIMIT 1`
      )
      .get(id);
    if (row == null || row.procentaj_emag == null) return null;
    const pct = Number(row.procentaj_emag);
    if (!Number.isFinite(pct)) return null;
    const commissionValue =
      row.commission_value == null ? null : Number(row.commission_value);
    return {
      procentaj_emag: pct,
      commission_value: Number.isFinite(commissionValue) ? commissionValue : null,
      fetched_at: row.fetched_at ?? null,
    };
  } catch {
    return null;
  }
}

function lookupProcentajEmag(offerId) {
  return lookupCommission(offerId)?.procentaj_emag ?? null;
}

function lookupCommissionsBulk(offerIds) {
  const ids = [
    ...new Set(
      (Array.isArray(offerIds) ? offerIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id))
    ),
  ];
  if (ids.length === 0) return {};

  try {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = getDb()
      .prepare(
        `SELECT offer_id, procentaj_emag, commission_value, fetched_at
         FROM product_procentaj_emag WHERE offer_id IN (${placeholders})`
      )
      .all(...ids);

    const out = {};
    for (const row of rows) {
      if (row.procentaj_emag == null) continue;
      const pct = Number(row.procentaj_emag);
      if (!Number.isFinite(pct)) continue;
      const commissionValue =
        row.commission_value == null ? null : Number(row.commission_value);
      out[row.offer_id] = {
        procentaj_emag: pct,
        commission_value: Number.isFinite(commissionValue) ? commissionValue : null,
        fetched_at: row.fetched_at ?? null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function saveCommissionFromEmag(offerId, { commission_value, procentaj_emag }) {
  const id = Number(offerId);
  const comm = Number(commission_value);
  const pct = Number(procentaj_emag);
  if (!Number.isFinite(id) || !Number.isFinite(comm) || !Number.isFinite(pct)) {
    throw new Error("id, commission_value și procentaj_emag trebuie să fie numere");
  }
  const fetched_at = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO product_procentaj_emag (offer_id, procentaj_emag, commission_value, fetched_at)
       VALUES (@offer_id, @procentaj_emag, @commission_value, @fetched_at)
       ON CONFLICT(offer_id) DO UPDATE SET
         procentaj_emag = excluded.procentaj_emag,
         commission_value = excluded.commission_value,
         fetched_at = excluded.fetched_at`
    )
    .run({ offer_id: id, procentaj_emag: pct, commission_value: comm, fetched_at });
  return { procentaj_emag: pct, commission_value: comm, fetched_at };
}

function saveProcentajEmag(offerId, value) {
  const id = Number(offerId);
  const n = Number(value);
  if (!Number.isFinite(id) || !Number.isFinite(n)) {
    throw new Error("id și procentaj_emag trebuie să fie numere");
  }
  return saveCommissionFromEmag(id, { commission_value: 0, procentaj_emag: n });
}

function clearProcentajEmag(offerId) {
  const id = Number(offerId);
  if (!Number.isFinite(id)) {
    throw new Error("id invalid");
  }
  getDb()
    .prepare("DELETE FROM product_procentaj_emag WHERE offer_id = ?")
    .run(id);
  return null;
}

const PRICE_EPSILON = 0.00005;

function recordPretEmagIfChanged(offerId, salePrice, currency, source) {
  const id = Number(offerId);
  const price = Number(salePrice);
  if (!Number.isFinite(id) || !Number.isFinite(price)) return null;

  const last = getDb()
    .prepare(
      `SELECT sale_price FROM product_pret_emag_history
       WHERE offer_id = ?
       ORDER BY recorded_at DESC, id DESC LIMIT 1`
    )
    .get(id);

  if (last != null && Math.abs(Number(last.sale_price) - price) <= PRICE_EPSILON) {
    return null;
  }

  const recorded_at = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO product_pret_emag_history (offer_id, sale_price, currency, recorded_at, source)
       VALUES (@offer_id, @sale_price, @currency, @recorded_at, @source)`
    )
    .run({
      offer_id: id,
      sale_price: price,
      currency: currency || null,
      recorded_at,
      source: source || null,
    });
  return { offer_id: id, sale_price: price, recorded_at, source: source || null };
}

function getPretEmagHistory(offerId) {
  const id = Number(offerId);
  if (!Number.isFinite(id)) return [];
  try {
    return getDb()
      .prepare(
        `SELECT sale_price, currency, recorded_at, source
         FROM product_pret_emag_history
         WHERE offer_id = ?
         ORDER BY recorded_at ASC, id ASC`
      )
      .all(id);
  } catch {
    return [];
  }
}

function getLastPriceChangeBulk(offerIds) {
  const ids = [
    ...new Set(
      (Array.isArray(offerIds) ? offerIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id))
    ),
  ];
  if (ids.length === 0) return {};

  try {
    const placeholders = ids.map(() => "?").join(", ");
    // Latest row per offer_id by recorded_at (tie-broken by id).
    const rows = getDb()
      .prepare(
        `SELECT h.offer_id, h.sale_price, h.recorded_at
         FROM product_pret_emag_history h
         JOIN (
           SELECT offer_id, MAX(id) AS max_id
           FROM product_pret_emag_history
           WHERE offer_id IN (${placeholders})
           GROUP BY offer_id
         ) last ON last.offer_id = h.offer_id AND last.max_id = h.id`
      )
      .all(...ids);

    const out = {};
    for (const row of rows) {
      out[row.offer_id] = {
        sale_price: Number(row.sale_price),
        recorded_at: row.recorded_at,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function upsertOrderLines(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const stmt = getDb().prepare(
    `INSERT INTO order_line_history
       (line_id, order_id, product_id, part_number, name, quantity, sale_price, status, currency, order_date)
     VALUES (@line_id, @order_id, @product_id, @part_number, @name, @quantity, @sale_price, @status, @currency, @order_date)
     ON CONFLICT(line_id) DO UPDATE SET
       order_id = excluded.order_id,
       product_id = excluded.product_id,
       part_number = excluded.part_number,
       name = excluded.name,
       quantity = excluded.quantity,
       sale_price = excluded.sale_price,
       status = excluded.status,
       currency = excluded.currency,
       order_date = excluded.order_date`
  );

  const toNum = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const run = getDb().transaction((rows) => {
    let count = 0;
    for (const r of rows) {
      const line_id = toNum(r?.line_id);
      const order_id = toNum(r?.order_id);
      if (line_id == null || order_id == null) continue;
      stmt.run({
        line_id,
        order_id,
        product_id: toNum(r?.product_id),
        part_number: r?.part_number ?? null,
        name: r?.name ?? null,
        quantity: toNum(r?.quantity),
        sale_price: toNum(r?.sale_price),
        status: toNum(r?.status),
        currency: r?.currency ?? null,
        order_date: r?.order_date ?? null,
      });
      count += 1;
    }
    return count;
  });

  try {
    return run(list);
  } catch {
    return 0;
  }
}

function getOrderLinesForProduct(offerId) {
  const id = Number(offerId);
  if (!Number.isFinite(id)) return [];
  try {
    return getDb()
      .prepare(
        `SELECT line_id, order_id, product_id, part_number, name, quantity,
                sale_price, status, currency, order_date
         FROM order_line_history
         WHERE product_id = ?
         ORDER BY order_date DESC, order_id DESC`
      )
      .all(id);
  } catch {
    return [];
  }
}

module.exports = {
  getDb,
  lookupPretCumparare,
  recordPretEmagIfChanged,
  getPretEmagHistory,
  getLastPriceChangeBulk,
  upsertOrderLines,
  getOrderLinesForProduct,
  lookupAlteCosturi,
  lookupAlteCosturiBulk,
  saveAlteCosturi,
  clearAlteCosturi,
  lookupPretContabil,
  lookupPretContabilBulk,
  lookupCostOverridesBulk,
  savePretContabil,
  clearPretContabil,
  lookupPretMinim,
  savePretMinim,
  clearPretMinim,
  lookupProcentajEmag,
  lookupCommission,
  lookupCommissionsBulk,
  saveProcentajEmag,
  saveCommissionFromEmag,
  clearProcentajEmag,
  getSettings,
  saveSettings,
  DB_PATH,
};
