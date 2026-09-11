/**
 * Import pret_cumparare_usd (+ optional link_cumparare) din Excel-ul de produse.
 *
 * Usage:
 *   node scripts/import-purchase-usd.js [path/to/file.xlsx]
 *
 * Default path: backend/document_produse_updated_updated_regenerated_ean_PNK_tmp.xlsx
 * Potriveste dupa COD PRODUS, apoi EAN, apoi PNK.
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { ensureSchema, endPool } = require("../pg");
const { updateCatalogPurchaseMeta } = require("../marketplace-db");

const ROOT = path.join(__dirname, "..");
const DEFAULT_PATH = path.join(
  ROOT,
  "document_produse_updated_updated_regenerated_ean_PNK_tmp.xlsx"
);

function normalizeHeader(h) {
  return String(h ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function pickHeader(headers, predicates) {
  for (const h of headers) {
    const n = normalizeHeader(h);
    for (const pred of predicates) {
      if (pred(n)) return h;
    }
  }
  return null;
}

function cellStr(row, key) {
  if (!key) return "";
  const v = row[key];
  if (v == null || v === "") return "";
  return String(v).trim();
}

function cellNum(row, key) {
  if (!key) return null;
  const v = row[key];
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const cleaned = String(v)
    .trim()
    .replace(/\s/g, "")
    .replace(/\$/g, "")
    .replace(/usd/gi, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function detectColumns(headers) {
  const cod = pickHeader(headers, [
    (n) => n === "cod produs" || n === "cod_produs" || n === "sku",
    (n) => n.includes("cod") && n.includes("produs"),
  ]);
  const ean = pickHeader(headers, [
    (n) => n === "ean" || n === "ean13" || n === "barcode",
    (n) => n.includes("ean"),
  ]);
  const pnk = pickHeader(headers, [
    (n) => n === "pnk" || n === "part number key" || n === "part_number_key",
    (n) => n.includes("pnk"),
  ]);
  const usd = pickHeader(headers, [
    (n) => n.includes("dolar") || n.includes("dollar"),
    (n) => n.includes("usd") && (n.includes("pret") || n.includes("price") || n.includes("cost") || n.includes("cumpar")),
    (n) => n === "usd" || n === "price usd" || n === "cost usd" || n === "$",
    (n) => n.includes("pret") && n.includes("usd"),
    (n) => n.includes("unitar") && (n.includes("usd") || n.includes("$")),
  ]);
  const link = pickHeader(headers, [
    (n) => n.includes("link") && (n.includes("cumpar") || n.includes("achiz") || n.includes("buy") || n.includes("sursa")),
    (n) => n === "link" || n === "url" || n === "product url" || n === "alibaba" || n === "aliexpress",
    (n) => n.includes("link"),
  ]);
  return { cod, ean, pnk, usd, link };
}

async function main() {
  const xlsxPath = path.resolve(process.argv[2] || DEFAULT_PATH);
  if (!fs.existsSync(xlsxPath)) {
    console.error(`Lipsește Excel: ${xlsxPath}`);
    console.error(
      "Copiază document_produse_updated_updated_regenerated_ean_PNK_tmp.xlsx în backend/ sau treci calea ca argument."
    );
    process.exit(1);
  }

  await ensureSchema();

  const workbook = XLSX.readFile(xlsxPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Incearca range=3 (format vechi cu antet pe randul 4), apoi range=0.
  let rows = XLSX.utils.sheet_to_json(sheet, { range: 3, defval: null });
  let headers = rows.length ? Object.keys(rows[0]) : [];
  let cols = detectColumns(headers);

  if (!cols.usd) {
    rows = XLSX.utils.sheet_to_json(sheet, { range: 0, defval: null });
    headers = rows.length ? Object.keys(rows[0]) : [];
    cols = detectColumns(headers);
  }

  console.log("Sheet:", sheetName);
  console.log("Coloane detectate:", cols);
  console.log("Headers:", headers);

  if (!cols.usd) {
    console.error("Nu am găsit o coloană de preț USD în Excel.");
    process.exit(1);
  }
  if (!cols.cod && !cols.ean && !cols.pnk) {
    console.error("Nu am găsit COD PRODUS / EAN / PNK pentru potrivire.");
    process.exit(1);
  }

  const items = rows
    .map((row) => {
      const item = {
        cod_produs: cellStr(row, cols.cod) || null,
        ean: cellStr(row, cols.ean) || null,
        part_number_key: cellStr(row, cols.pnk) || null,
        pret_cumparare_usd: cellNum(row, cols.usd),
      };
      if (cols.link) {
        item.link_cumparare = cellStr(row, cols.link) || null;
      }
      return item;
    })
    .filter(
      (r) =>
        (r.cod_produs || r.ean || r.part_number_key) &&
        r.pret_cumparare_usd != null
    );

  const result = await updateCatalogPurchaseMeta(items);
  console.log(
    `Import USD OK: ${items.length} rânduri Excel cu USD; actualizate=${result.updated}, fără potrivire=${result.unmatched}`
  );
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
