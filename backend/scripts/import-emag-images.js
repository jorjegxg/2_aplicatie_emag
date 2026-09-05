/**
 * Import unic poze eMAG -> MinIO.
 *
 * Citeste ofertele din eMAG (product_offer/read), le potriveste cu randurile din
 * catalog_products dupa emag_offer_id, sterge pozele importate anterior din eMAG
 * si le descarca din nou in bucket-ul S3/MinIO. Pozele urcate manual raman intacte.
 *
 * Ruleaza doar de pe IP-ul whitelisted la eMAG.
 *
 * Utilizare:
 *   node scripts/import-emag-images.js
 *   node scripts/import-emag-images.js --dry-run
 *   node scripts/import-emag-images.js --limit 20
 *   node scripts/import-emag-images.js --offer-id 123456
 */
const { query, ensureSchema, endPool } = require("../pg");
const emagChannel = require("../channels/emag");
const { ensureBucket, replaceRemoteImages } = require("../product-images");

const MAX_PAGES = 50;
const DELAY_MS = 150;

function parseArgs(argv) {
  const args = { dryRun: false, limit: Infinity, offerId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--limit") args.limit = Number(argv[++i]) || Infinity;
    else if (a === "--offer-id") args.offerId = String(argv[++i] || "").trim();
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findProductId(offerId) {
  const { rows } = await query(
    `SELECT id FROM catalog_products WHERE emag_offer_id = $1 LIMIT 1`,
    [String(offerId)]
  );
  return rows.length ? Number(rows[0].id) : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureSchema();
  if (!args.dryRun) await ensureBucket();

  const stats = {
    offers: 0,
    matched: 0,
    unmatched: 0,
    noImages: 0,
    processed: 0,
    deleted: 0,
    downloaded: 0,
    failed: 0,
  };

  let page = 1;
  while (page <= MAX_PAGES && stats.processed < args.limit) {
    const result = await emagChannel.fetchListings({ page });
    const listings = result.listings || [];
    stats.offers += listings.length;

    for (const offer of listings) {
      if (stats.processed >= args.limit) break;
      if (args.offerId && String(offer.id) !== args.offerId) continue;

      const urls = (offer.images || []).map((im) => im.url);
      const productId = await findProductId(offer.id);

      if (!productId) {
        stats.unmatched += 1;
        console.warn(`[skip] oferta ${offer.id} nu are produs local (emag_offer_id)`);
        continue;
      }
      stats.matched += 1;

      if (!urls.length) {
        stats.noImages += 1;
        continue;
      }

      if (args.dryRun) {
        stats.processed += 1;
        console.log(`[dry-run] produs ${productId} (oferta ${offer.id}): ${urls.length} poze`);
        continue;
      }

      try {
        const res = await replaceRemoteImages(productId, urls);
        stats.processed += 1;
        stats.deleted += res.deleted;
        stats.downloaded += res.added.length;
        stats.failed += res.failed.length;
        for (const f of res.failed) {
          console.warn(`[eroare] produs ${productId} ${f.url}: ${f.error}`);
        }
        console.log(
          `[ok] produs ${productId} (oferta ${offer.id}): -${res.deleted} +${res.added.length}` +
            (res.failed.length ? ` (${res.failed.length} esuate)` : "")
        );
      } catch (err) {
        stats.failed += urls.length;
        console.error(`[eroare] produs ${productId} (oferta ${offer.id}): ${err.message}`);
      }

      await sleep(DELAY_MS);
    }

    if (!result.hasMore || listings.length === 0) break;
    page += 1;
  }

  console.log("\n--- raport import poze eMAG ---");
  console.log(`oferte citite:        ${stats.offers}`);
  console.log(`produse potrivite:    ${stats.matched}`);
  console.log(`oferte fara produs:   ${stats.unmatched}`);
  console.log(`oferte fara poze:     ${stats.noImages}`);
  console.log(`produse procesate:    ${stats.processed}`);
  console.log(`poze vechi sterse:    ${stats.deleted}`);
  console.log(`poze descarcate:      ${stats.downloaded}`);
  console.log(`poze esuate:          ${stats.failed}`);
}

main()
  .catch((err) => {
    console.error("[import-emag-images]", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await endPool();
    } catch {
      /* ignore */
    }
  });
