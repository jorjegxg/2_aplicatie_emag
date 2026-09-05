/**
 * Import Excel magazin -> catalog_products (+ poze locale din "Locatie Poze").
 *
 * Usage:
 *   node scripts/import-excel.js
 *   node scripts/import-excel.js --xlsx "D:/path/file.xlsx"
 *   node scripts/import-excel.js --xlsx "..." --photos-root "D:/magazine_online/produse unzipped"
 *   node scripts/import-excel.js --dry-run
 *   node scripts/import-excel.js --skip-images
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { ensureSchema, endPool, query } = require("../pg");
const { upsertCatalogProducts } = require("../marketplace-db");
const { addImages, ensureBucket } = require("../product-images");

const ROOT = path.join(__dirname, "..");
const DEFAULT_XLSX = path.join(ROOT, "document_produse_with_poze.xlsx");
const DEFAULT_PHOTOS_ROOT = "D:/magazine_online/produse unzipped";

const COL = {
  nume: "Nume produs",
  cod: "COD PRODUS",
  brand: "Brand",
  ean: "EAN",
  descriere: "Descriere RO",
  pret: "Preț unitar (RON)",
  sale: "Preț vânzare (RON)",
  prp: "PRP",
  min: "Validare pret : Prag Minim",
  max: "Validare pret : Prag Maxim",
  stoc: "Stoc",
  familie: "Nume familie",
  idFamilie: "ID familie",
  pnk: "PNK",
  locatie: "Locatie Poze",
};

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function parseArgs(argv) {
  const out = {
    xlsx: DEFAULT_XLSX,
    photosRoot: DEFAULT_PHOTOS_ROOT,
    dryRun: false,
    skipImages: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--xlsx") out.xlsx = argv[++i];
    else if (a === "--photos-root") out.photosRoot = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--skip-images") out.skipImages = true;
  }
  return out;
}

function cellStr(row, key) {
  const v = row[key];
  if (v == null || v === "") return "";
  return String(v).replace(/\r\n/g, "\n").trim();
}

function cellNum(row, key) {
  const v = row[key];
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^\d.,-]/g).replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function resolvePhotoDir(locatie, photosRoot) {
  const raw = locatie == null ? "" : String(locatie).replace(/\r\n/g, "\n").trim();
  if (!raw || /^LIPS/i.test(raw)) return null;
  if (fs.existsSync(raw) && fs.statSync(raw).isDirectory()) return raw;

  const base = path.basename(raw);
  const flat = path.join(photosRoot, base);
  if (fs.existsSync(flat) && fs.statSync(flat).isDirectory()) return flat;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      if (ent.name === base) return full;
      const hit = walk(full);
      if (hit) return hit;
    }
    return null;
  };
  return walk(photosRoot);
}

function listImageFiles(dir) {
  if (!dir) return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => MIME_BY_EXT[path.extname(n).toLowerCase()])
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((n) => path.join(dir, n));
}

function fileToUpload(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  const buffer = fs.readFileSync(filePath);
  return {
    buffer,
    mimetype: mime,
    originalname: path.basename(filePath),
    size: buffer.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.xlsx)) {
    console.error(`Lipsește Excel: ${args.xlsx}`);
    process.exit(1);
  }

  await ensureSchema();
  if (!args.skipImages) await ensureBucket();

  const workbook = XLSX.readFile(args.xlsx);
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    range: 3,
    defval: null,
  });

  const catalogRows = [];
  const photoJobs = [];

  for (const row of rows) {
    const cod = cellStr(row, COL.cod);
    const nume = cellStr(row, COL.nume);
    if (!cod && !nume) continue;

    catalogRows.push({
      cod_produs: cod || null,
      nume: nume || null,
      descriere: cellStr(row, COL.descriere) || null,
      brand: cellStr(row, COL.brand) || null,
      ean: cellStr(row, COL.ean) || null,
      pret_cumparare: cellNum(row, COL.pret),
      part_number: cod || null,
      part_number_key: cellStr(row, COL.pnk) || null,
      id_familie: cellNum(row, COL.idFamilie),
      familie: cellStr(row, COL.familie) || null,
      sale_price: cellNum(row, COL.sale),
      recommended_price: cellNum(row, COL.prp),
      min_sale_price: cellNum(row, COL.min),
      max_sale_price: cellNum(row, COL.max),
      general_stock: cellNum(row, COL.stoc),
      currency: "RON",
    });

    const locRaw = cellStr(row, COL.locatie);
    const dir = resolvePhotoDir(locRaw, args.photosRoot);
    photoJobs.push({
      cod,
      locRaw: locRaw || null,
      dir,
      files: listImageFiles(dir),
    });
  }

  console.log(
    `Excel: ${sheetName} | produse: ${catalogRows.length} | cu folder poze: ${
      photoJobs.filter((j) => j.dir).length
    }`
  );

  if (args.dryRun) {
    for (const j of photoJobs) {
      console.log(
        `[dry-run] ${j.cod || "?"} | poze=${j.files.length} | ${j.dir || j.locRaw || "—"}`
      );
    }
    await endPool();
    return;
  }

  const catalogCount = await upsertCatalogProducts(catalogRows);
  console.log(`Catalog upsert: ${catalogCount} rânduri`);

  if (args.skipImages) {
    await endPool();
    return;
  }

  const stats = { products: 0, images: 0, skippedHasManual: 0, missingDir: 0, errors: 0 };

  for (const job of photoJobs) {
    if (!job.cod) continue;
    if (!job.dir) {
      if (job.locRaw) {
        stats.missingDir += 1;
        console.warn(`[poze] lipsa folder: ${job.cod} | ${job.locRaw}`);
      }
      continue;
    }
    if (!job.files.length) {
      console.warn(`[poze] folder gol: ${job.cod} | ${job.dir}`);
      continue;
    }

    const { rows: found } = await query(
      `SELECT c.id,
              (SELECT count(*)::int FROM product_images pi
               WHERE pi.product_id = c.id AND pi.source_url IS NULL) AS manual_count
       FROM catalog_products c
       WHERE c.cod_produs = $1
       LIMIT 1`,
      [job.cod]
    );
    if (!found.length) {
      stats.errors += 1;
      console.warn(`[poze] produs negasit dupa upsert: ${job.cod}`);
      continue;
    }

    const productId = found[0].id;
    if (Number(found[0].manual_count) > 0) {
      stats.skippedHasManual += 1;
      continue;
    }

    try {
      const uploads = job.files.map(fileToUpload);
      const inserted = await addImages(productId, uploads);
      stats.products += 1;
      stats.images += inserted.length;
      console.log(`[poze] ${job.cod}: +${inserted.length}`);
    } catch (err) {
      stats.errors += 1;
      console.error(`[poze] ${job.cod}: ${err.message}`);
    }
  }

  console.log("\n--- raport ---");
  console.log(`catalog:              ${catalogCount}`);
  console.log(`produse cu poze noi:  ${stats.products}`);
  console.log(`poze uploadate:       ${stats.images}`);
  console.log(`sarite (deja manual): ${stats.skippedHasManual}`);
  console.log(`folder lipsa:         ${stats.missingDir}`);
  console.log(`erori:                ${stats.errors}`);

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
