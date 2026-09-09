/**
 * Scoate din catalog_products.nume codurile SKU interne (MAS-VOL, PARF-SOL, ARO-SOL etc.).
 *
 * Utilizare:
 *   node scripts/strip-sku-from-titles.js --dry-run
 *   node scripts/strip-sku-from-titles.js
 *   node scripts/strip-sku-from-titles.js --product-id 55
 */
const { query, ensureSchema, endPool } = require("../pg");

function parseArgs(argv) {
  const args = { dryRun: false, productId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--product-id") args.productId = Number(argv[++i]) || null;
  }
  return args;
}

/** Toate subsecvențele contigue de ≥2 segmente din cod (cel mai lung primul). */
function skuCandidates(codProdus) {
  const raw = String(codProdus || "").trim();
  if (!raw) return [];
  const parts = raw.split("-").filter(Boolean);
  if (parts.length < 2) return raw.length >= 2 ? [raw] : [];
  const set = new Set();
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 2; j <= parts.length; j++) {
      set.add(parts.slice(i, j).join("-"));
    }
  }
  return [...set].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTitle(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
}

/**
 * Elimină din titlu candidații SKU (ca token întreg) și "OEM" adiacent.
 */
function stripSkuFromTitle(nume, codProdus) {
  let result = String(nume || "");
  const candidates = skuCandidates(codProdus);
  if (!candidates.length) return normalizeTitle(result);

  for (const code of candidates) {
    const esc = escapeRegExp(code);
    // token întreg; opțional "OEM " imediat înainte
    const re = new RegExp(
      `(?:^|(?<=[\\s,]))(?:OEM\\s+)?${esc}(?=[\\s,]|$)`,
      "gi"
    );
    result = result.replace(re, "");
  }

  // OEM rămas izolat (dacă a rămas după alte curățări)
  result = result.replace(/(?:^|(?<=[\s,]))OEM(?=[\s,]|$)/gi, "");

  return normalizeTitle(result);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureSchema();

  let sql = `
    SELECT id, cod_produs, nume
    FROM catalog_products
    WHERE nume IS NOT NULL
      AND NULLIF(TRIM(cod_produs), '') IS NOT NULL
  `;
  const params = [];
  if (args.productId) {
    params.push(args.productId);
    sql += ` AND id = $${params.length}`;
  }
  sql += ` ORDER BY id ASC`;

  const { rows } = await query(sql, params);
  let changed = 0;
  let skipped = 0;

  for (const row of rows) {
    const next = stripSkuFromTitle(row.nume, row.cod_produs);
    if (!next || next === normalizeTitle(row.nume)) {
      skipped += 1;
      continue;
    }
    changed += 1;
    console.log(`${row.id} | ${row.cod_produs}`);
    console.log(`  - ${row.nume}`);
    console.log(`  + ${next}`);

    if (!args.dryRun) {
      await query(
        `UPDATE catalog_products
         SET nume = $1, updated_at = NOW()
         WHERE id = $2`,
        [next, row.id]
      );
    }
  }

  console.log(
    args.dryRun
      ? `Dry-run: ${changed} de actualizat, ${skipped} neschimbate (din ${rows.length}).`
      : `Gata: ${changed} actualizate, ${skipped} neschimbate (din ${rows.length}).`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => endPool());
