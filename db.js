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
      numar_produse REAL
    );
  `);
  const cols = db.prepare("PRAGMA table_info(settings)").all();
  if (!cols.some((c) => c.name === "numar_produse")) {
    db.exec("ALTER TABLE settings ADD COLUMN numar_produse REAL");
  }
  db.exec(`
    INSERT OR IGNORE INTO settings (id, pret_transport, pret_contabil, procentaj_emag, numar_produse)
    VALUES (1, NULL, NULL, NULL, NULL);
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
      "SELECT pret_transport, pret_contabil, procentaj_emag, numar_produse FROM settings WHERE id = 1"
    )
    .get();
  return {
    pret_transport: row?.pret_transport ?? null,
    pret_contabil: row?.pret_contabil ?? null,
    procentaj_emag: row?.procentaj_emag ?? null,
    numar_produse: row?.numar_produse ?? null,
  };
}

function saveSettings({
  pret_transport,
  pret_contabil,
  procentaj_emag,
  numar_produse,
}) {
  getDb()
    .prepare(
      `UPDATE settings
       SET pret_transport = @pret_transport,
           pret_contabil = @pret_contabil,
           procentaj_emag = @procentaj_emag,
           numar_produse = @numar_produse
       WHERE id = 1`
    )
    .run({
      pret_transport,
      pret_contabil,
      procentaj_emag,
      numar_produse,
    });
  return getSettings();
}

module.exports = {
  lookupPretCumparare,
  getSettings,
  saveSettings,
  DB_PATH,
};
