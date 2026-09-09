/**
 * Reordoneaza pozele existente: packshot (produs pe fundal alb) ca poza principala.
 *
 * Utilizare:
 *   node scripts/prefer-white-bg-primary.js
 *   node scripts/prefer-white-bg-primary.js --dry-run
 *   node scripts/prefer-white-bg-primary.js --limit 50
 *   node scripts/prefer-white-bg-primary.js --product-id 123
 */
const { query, ensureSchema, endPool } = require("../pg");
const {
  ensureBucket,
  preferWhiteBackgroundPrimary,
  listForProduct,
  getObjectBuffer,
} = require("../product-images");
const { scoreWhiteBackground } = require("../image-white-bg");

function parseArgs(argv) {
  const args = { dryRun: false, limit: Infinity, productId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--limit") args.limit = Number(argv[++i]) || Infinity;
    else if (a === "--product-id") args.productId = Number(argv[++i]) || null;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureSchema();
  if (!args.dryRun) await ensureBucket();

  let sql = `
    SELECT product_id, COUNT(*)::int AS cnt
    FROM product_images
    GROUP BY product_id
    HAVING COUNT(*) >= 2
  `;
  const params = [];
  if (args.productId) {
    sql += ` AND product_id = $1`;
    params.push(args.productId);
  }
  sql += ` ORDER BY product_id ASC`;

  const { rows } = await query(sql, params);
  const targets = rows.slice(0, Number.isFinite(args.limit) ? args.limit : rows.length);

  const stats = { products: targets.length, changed: 0, skipped: 0, errors: 0 };

  console.log(
    `Produse cu ≥2 poze: ${rows.length}; procesez ${targets.length}` +
      (args.dryRun ? " (dry-run)" : "")
  );

  for (const row of targets) {
    const pid = Number(row.product_id);
    try {
      if (args.dryRun) {
        const { rows: imgs } = await query(
          `SELECT id, stored_name, sort_order FROM product_images
           WHERE product_id = $1 ORDER BY sort_order ASC, id ASC`,
          [pid]
        );
        await ensureBucket();
        let bestId = null;
        let bestScore = -1;
        for (const img of imgs) {
          let score = 0;
          try {
            const buf = await getObjectBuffer(img.stored_name);
            score = await scoreWhiteBackground(buf);
          } catch {
            score = 0;
          }
          if (score > bestScore) {
            bestScore = score;
            bestId = Number(img.id);
          }
        }
        const currentFirst = Number(imgs[0]?.id);
        if (bestId != null && bestId !== currentFirst) {
          stats.changed += 1;
          console.log(
            `[dry-run] produs ${pid}: principală ${currentFirst} → ${bestId} (scor ${bestScore.toFixed(3)})`
          );
        } else {
          stats.skipped += 1;
        }
        continue;
      }

      const before = await listForProduct(pid);
      const beforeId = before[0]?.id;
      const after = await preferWhiteBackgroundPrimary(pid);
      const afterId = after[0]?.id;
      if (beforeId !== afterId) {
        stats.changed += 1;
        console.log(`[ok] produs ${pid}: principală ${beforeId} → ${afterId}`);
      } else {
        stats.skipped += 1;
      }
    } catch (err) {
      stats.errors += 1;
      console.error(`[eroare] produs ${pid}: ${err.message}`);
    }
  }

  console.log("\n--- raport prefer white-bg ---");
  console.log(`produse procesate: ${stats.products}`);
  console.log(`reordonate:        ${stats.changed}`);
  console.log(`neschimbate:       ${stats.skipped}`);
  console.log(`erori:             ${stats.errors}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => endPool());
