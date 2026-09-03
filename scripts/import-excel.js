const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const Database = require("better-sqlite3");
const { upsertCatalogProducts } = require("../marketplace-db");

const ROOT = path.join(__dirname, "..");
const XLSX_PATH = path.join(ROOT, "document_produse_with_poze.xlsx");
const DB_PATH = path.join(ROOT, "data", "products.db");

const COL = {
  nume: "Nume produs",
  cod: "COD PRODUS",
  pret: "Preț unitar (RON)",
};

function cellStr(row, key) {
  const v = row[key];
  if (v == null || v === "") return "";
  return String(v).trim();
}

function cellNum(row, key) {
  const v = row[key];
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function main() {
  if (!fs.existsSync(XLSX_PATH)) {
    console.error(`Lipsește Excel: ${XLSX_PATH}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const workbook = XLSX.readFile(XLSX_PATH);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Header pe rândul 4 (1-indexed) → rangeStartRow 3 (0-indexed) via sheet_to_json default
  const rows = XLSX.utils.sheet_to_json(sheet, {
    range: 3,
    defval: null,
  });

  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cod_produs TEXT,
      nume_produs TEXT NOT NULL,
      pret_cumparare REAL,
      UNIQUE(cod_produs)
    );
    CREATE INDEX IF NOT EXISTS idx_products_nume ON products(nume_produs COLLATE NOCASE);
  `);

  const upsertByCod = db.prepare(`
    INSERT INTO products (cod_produs, nume_produs, pret_cumparare)
    VALUES (@cod_produs, @nume_produs, @pret_cumparare)
    ON CONFLICT(cod_produs) DO UPDATE SET
      nume_produs = excluded.nume_produs,
      pret_cumparare = excluded.pret_cumparare
  `);

  const insertNoCod = db.prepare(`
    INSERT INTO products (cod_produs, nume_produs, pret_cumparare)
    VALUES (NULL, @nume_produs, @pret_cumparare)
  `);

  const deleteAll = db.prepare("DELETE FROM products");

  let imported = 0;
  let skipped = 0;

  const tx = db.transaction((items) => {
    deleteAll.run();
    for (const row of items) {
      const cod = cellStr(row, COL.cod);
      const nume = cellStr(row, COL.nume);
      const pret = cellNum(row, COL.pret);

      if (!cod && !nume) {
        skipped += 1;
        continue;
      }

      const payload = {
        cod_produs: cod || null,
        nume_produs: nume || cod,
        pret_cumparare: pret,
      };

      if (cod) {
        upsertByCod.run(payload);
      } else {
        insertNoCod.run(payload);
      }
      imported += 1;
    }
  });

  tx(rows);
  db.close();

  // Oglindeste importul in catalog_products (sursa de adevar pentru pretul de cumparare).
  const catalogCount = upsertCatalogProducts(
    rows
      .map((row) => ({
        cod_produs: cellStr(row, COL.cod) || null,
        nume: cellStr(row, COL.nume) || null,
        pret_cumparare: cellNum(row, COL.pret),
      }))
      .filter((r) => r.cod_produs || r.nume)
  );
  console.log(`Catalog actualizat: ${catalogCount} produse în catalog_products`);

  console.log(
    `Import OK: ${imported} produse în ${DB_PATH} (sărite: ${skipped}, sheet: ${sheetName})`
  );
}

main();
