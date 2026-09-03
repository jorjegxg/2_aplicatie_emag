const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { ensureSchema, endPool } = require("../pg");
const { upsertCatalogProducts } = require("../marketplace-db");

const ROOT = path.join(__dirname, "..");
const XLSX_PATH = path.join(ROOT, "document_produse_with_poze.xlsx");

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

async function main() {
  if (!fs.existsSync(XLSX_PATH)) {
    console.error(`Lipsește Excel: ${XLSX_PATH}`);
    process.exit(1);
  }

  await ensureSchema();

  const workbook = XLSX.readFile(XLSX_PATH);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const rows = XLSX.utils.sheet_to_json(sheet, {
    range: 3,
    defval: null,
  });

  const catalogRows = rows
    .map((row) => ({
      cod_produs: cellStr(row, COL.cod) || null,
      nume: cellStr(row, COL.nume) || null,
      pret_cumparare: cellNum(row, COL.pret),
    }))
    .filter((r) => r.cod_produs || r.nume);

  const catalogCount = await upsertCatalogProducts(catalogRows);
  console.log(`Catalog actualizat: ${catalogCount} produse în catalog_products`);
  console.log(`Import OK (sheet: ${sheetName}, rânduri Excel mapate: ${catalogRows.length})`);
  await endPool();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await endPool();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
