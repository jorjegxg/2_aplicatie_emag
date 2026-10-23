/**
 * Exportă toate pozele din MinIO pe disc, câte un folder per cod de produs:
 *   <out>/<cod_produs>/<platforma>/01.jpg, 02.jpg, ...
 * Platforma e setul de poze (en = implicit, ro / hu / bg = pe limbi).
 * Rulează în containerul back (are env-ul S3 + DB):
 *   docker exec emag-back node scripts/export-product-images.js /tmp/poze-export
 * De obicei îl pornește scripts/export-poze.sh.
 */
const fs = require("fs");
const path = require("path");
const { getObjectBuffer } = require("../product-images");
const { query, ensureSchema } = require("../pg");

const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** Nume de folder valid și pe Windows (laptopul descarcă acolo). */
function folderName(cod, productId) {
  const clean = String(cod || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "");
  return clean || `fara-cod-${productId}`;
}

function extFor(row) {
  const fromName = path.extname(row.stored_name || "").toLowerCase();
  return fromName || EXT_BY_MIME[String(row.mime_type || "").toLowerCase()] || ".jpg";
}

async function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("Folosire: node scripts/export-product-images.js <folder-iesire>");
    process.exit(2);
  }
  await ensureSchema();

  const { rows } = await query(
    `SELECT i.product_id, i.platform, i.stored_name, i.mime_type, c.cod_produs
       FROM product_images i
       JOIN catalog_products c ON c.id = i.product_id
      ORDER BY c.cod_produs, i.platform, i.sort_order, i.id`
  );

  fs.mkdirSync(outDir, { recursive: true });
  const counters = new Map();
  const products = new Set();
  let written = 0;
  let failed = 0;

  for (const row of rows) {
    const folder = folderName(row.cod_produs, row.product_id);
    const dir = path.join(outDir, folder, row.platform);
    const key = `${folder}/${row.platform}`;
    const n = (counters.get(key) || 0) + 1;
    counters.set(key, n);
    try {
      const buf = await getObjectBuffer(row.stored_name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${String(n).padStart(2, "0")}${extFor(row)}`), buf);
      products.add(folder);
      written++;
    } catch (err) {
      console.warn(`lipsă în MinIO: ${folder} ${row.platform} ${row.stored_name} (${err.message})`);
      failed++;
    }
  }

  console.log(`Poze exportate: ${written}, produse: ${products.size}, erori: ${failed}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
