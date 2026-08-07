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
      `SELECT procentaj_emag, procentaj_alte_costuri, mult_prp, mult_min, mult_max
       FROM settings WHERE id = 1`
    )
    .get();
  return {
    procentaj_emag: row?.procentaj_emag ?? null,
    procentaj_alte_costuri: row?.procentaj_alte_costuri ?? null,
    mult_prp: row?.mult_prp ?? null,
    mult_min: row?.mult_min ?? null,
    mult_max: row?.mult_max ?? null,
  };
}

function saveSettings({
  procentaj_emag,
  procentaj_alte_costuri,
  mult_prp,
  mult_min,
  mult_max,
}) {
  getDb()
    .prepare(
      `UPDATE settings
       SET procentaj_emag = @procentaj_emag,
           procentaj_alte_costuri = @procentaj_alte_costuri,
           mult_prp = @mult_prp,
           mult_min = @mult_min,
           mult_max = @mult_max
       WHERE id = 1`
    )
    .run({
      procentaj_emag,
      procentaj_alte_costuri,
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

module.exports = {
  lookupPretCumparare,
  lookupAlteCosturi,
  saveAlteCosturi,
  clearAlteCosturi,
  getSettings,
  saveSettings,
  DB_PATH,
};
