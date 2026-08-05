const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "data", "products.db");

let db = null;

function getDb() {
  if (db) return db;
  if (!fs.existsSync(DB_PATH)) return null;
  db = new Database(DB_PATH, { readonly: true });
  return db;
}

function lookupPretCumparare(partNumber, name) {
  const database = getDb();
  if (!database) return null;

  const cod = String(partNumber ?? "").trim();
  if (cod) {
    const byCod = database
      .prepare(
        "SELECT pret_cumparare FROM products WHERE cod_produs = ? COLLATE NOCASE LIMIT 1"
      )
      .get(cod);
    if (byCod && byCod.pret_cumparare != null) {
      return byCod.pret_cumparare;
    }
  }

  const nume = String(name ?? "").trim();
  if (nume) {
    const byNume = database
      .prepare(
        "SELECT pret_cumparare FROM products WHERE nume_produs = ? COLLATE NOCASE LIMIT 1"
      )
      .get(nume);
    if (byNume && byNume.pret_cumparare != null) {
      return byNume.pret_cumparare;
    }
  }

  return null;
}

module.exports = { lookupPretCumparare, DB_PATH };
