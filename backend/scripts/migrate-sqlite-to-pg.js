/**
 * One-shot: copiază datele din data/products.db (SQLite) în Postgres.
 * Rulează o dată după ce Postgres e up: node scripts/migrate-sqlite-to-pg.js
 */
const fs = require("fs");
const path = require("path");
let Database;
try {
  Database = require("better-sqlite3");
} catch {
  console.error(
    "Pentru migrare, instalează temporar: npm install better-sqlite3 --no-save"
  );
  process.exit(1);
}
const { query, ensureSchema, endPool, withTransaction } = require("../pg");

const ROOT = path.join(__dirname, "..");
const SQLITE_PATH = path.join(ROOT, "data", "products.db");

const TABLES = [
  "app_meta",
  "settings",
  "products",
  "catalog_products",
  "marketplace_listings",
  "product_pret_emag_history",
  "order_line_history",
  "app_logs",
];

/** Override-uri SQLite vechi → coloane pe catalog_products / marketplace_listings. */
async function mergeLegacyOverrides(sqlite) {
  if (tableExists(sqlite, "product_alte_costuri")) {
    const rows = sqlite.prepare("SELECT offer_id, alte_costuri FROM product_alte_costuri").all();
    for (const r of rows) {
      await query(
        `UPDATE catalog_products
         SET transport_override = COALESCE(transport_override, $1)
         WHERE emag_offer_id = $2`,
        [r.alte_costuri, String(r.offer_id)]
      );
    }
    console.log(`  merge product_alte_costuri → catalog: ${rows.length}`);
  }
  if (tableExists(sqlite, "product_pret_minim")) {
    const rows = sqlite.prepare("SELECT offer_id, pret_minim FROM product_pret_minim").all();
    for (const r of rows) {
      await query(
        `UPDATE marketplace_listings
         SET pret_minim_override = COALESCE(pret_minim_override, $1)
         WHERE channel = 'emag' AND external_id = $2`,
        [r.pret_minim, String(r.offer_id)]
      );
    }
    console.log(`  merge product_pret_minim → listings: ${rows.length}`);
  }
  if (tableExists(sqlite, "product_procentaj_emag")) {
    const rows = sqlite
      .prepare(
        "SELECT offer_id, procentaj_emag, commission_value, fetched_at FROM product_procentaj_emag"
      )
      .all();
    for (const r of rows) {
      await query(
        `UPDATE marketplace_listings SET
           procentaj_emag = COALESCE(procentaj_emag, $1),
           commission_value = COALESCE(commission_value, $2),
           commission_fetched_at = COALESCE(commission_fetched_at, $3::timestamptz)
         WHERE channel = 'emag' AND external_id = $4`,
        [r.procentaj_emag, r.commission_value, r.fetched_at || null, String(r.offer_id)]
      );
    }
    console.log(`  merge product_procentaj_emag → listings: ${rows.length}`);
  }
}

function tableExists(sqlite, name) {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function columnsOf(sqlite, name) {
  return sqlite.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
}

async function copyTable(sqlite, table) {
  if (!tableExists(sqlite, table)) {
    console.log(`  skip ${table} (lipsă în SQLite)`);
    return 0;
  }
  const cols = columnsOf(sqlite, table);
  if (cols.length === 0) return 0;

  // Intersectie cu coloanele Postgres (ignora coloane SQLite obsolete)
  const { rows: pgCols } = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  const pgSet = new Set(pgCols.map((r) => r.column_name));
  const useCols = cols.filter((c) => pgSet.has(c));
  if (useCols.length === 0) {
    console.log(`  skip ${table} (nici o coloană comună)`);
    return 0;
  }

  const rows = sqlite.prepare(`SELECT ${useCols.join(", ")} FROM ${table}`).all();
  if (rows.length === 0) {
    console.log(`  ${table}: 0 rânduri`);
    return 0;
  }

  await withTransaction(async (client) => {
    const placeholders = useCols.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO ${table} (${useCols.join(", ")}) VALUES (${placeholders})`;
    for (const row of rows) {
      await client.query(
        sql,
        useCols.map((c) => row[c])
      );
    }
  });

  // Reset identity sequences when we inserted explicit ids
  if (useCols.includes("id")) {
    await query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'),
                     COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`,
      [table]
    ).catch(() => {});
  }

  console.log(`  ${table}: ${rows.length} rânduri`);
  return rows.length;
}

async function main() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`Lipsește SQLite: ${SQLITE_PATH}`);
    process.exit(1);
  }

  console.log(`Migrare ${SQLITE_PATH} → Postgres…`);
  await ensureSchema();

  const existing = [];
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  for (const table of TABLES) {
    if (tableExists(sqlite, table)) existing.push(table);
  }

  if (existing.length) {
    await query(`TRUNCATE TABLE ${existing.join(", ")} RESTART IDENTITY CASCADE`);
  }

  let total = 0;
  try {
    for (const table of TABLES) {
      total += await copyTable(sqlite, table);
    }
    await mergeLegacyOverrides(sqlite);
  } finally {
    sqlite.close();
  }

  await query(`INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  console.log(`Gata. Total rânduri copiate: ${total}`);
  console.log(`Backup SQLite rămâne la: ${SQLITE_PATH}`);
  await endPool();
}

main().catch(async (err) => {
  console.error("Migrare eșuată:", err);
  try {
    await endPool();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
