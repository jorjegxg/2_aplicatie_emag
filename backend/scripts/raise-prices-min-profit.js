/*
 * Ridica pretul de vanzare (catalog_products.sale_price) la produsele cu % profit Tren/Mare
 * sub prag, la cel mai mic pret terminat in ,99 care atinge pragul. Restul raman neschimbate.
 * Foloseste acelasi calcul ca tabelul (calculator.js, comision implicit 25% ca in app.js).
 * Rulare: node scripts/raise-prices-min-profit.js [--apply] [--min=20]
 */
const { query, withTransaction, endPool } = require("../pg");
const { calcProduct } = require("../calculator");

const APPLY = process.argv.includes("--apply");
const minArg = process.argv.find((a) => a.startsWith("--min="));
const MIN = (minArg ? Number(minArg.slice(6)) : 20) / 100;
const DEFAULT_PROCENTAJ_EMAG = 25;
const EPS = 1e-9;

function pctTren(input, params, price) {
  return calcProduct({ ...input, pret_vanzare: price }, params)?.procent_profit_tren ?? null;
}

/** Cel mai mic pret X,99 cu % profit Tren >= MIN (profitul/pret creste cu pretul). */
function minPrice99(input, params) {
  const ok = (s) => (pctTren(input, params, s) ?? -Infinity) >= MIN - EPS;
  let hi = 1;
  while (!ok(hi)) {
    hi *= 2;
    if (hi > 1e7) return null;
  }
  let lo = 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  let s = Math.ceil(hi + 0.01) - 0.01; // urmatorul X,99 >= hi
  while (!ok(s)) s += 1;
  return Math.round(s * 100) / 100;
}

async function main() {
  const { rows: st } = await query("SELECT calculator_params FROM settings WHERE id = 1");
  const params = st[0]?.calculator_params || null;

  const { rows } = await query(`
    SELECT c.id, c.emag_offer_id, c.nume AS name, c.sale_price, c.max_sale_price,
           c.pret_cumparare_usd, c.moneda_fabrica, c.greutate, c.inaltime, c.lungime, c.latime,
           ml.procentaj_emag
    FROM catalog_products c
    LEFT JOIN marketplace_listings ml
      ON ml.channel = 'emag' AND ml.external_id = c.emag_offer_id
    ORDER BY c.id`);

  const changes = [];
  const skipped = [];
  let unchanged = 0;
  for (const r of rows) {
    const input = {
      pret_fabrica: r.pret_cumparare_usd,
      moneda: r.moneda_fabrica || "USD",
      greutate: r.greutate,
      inaltime: r.inaltime,
      lungime: r.lungime,
      latime: r.latime,
      comision_emag: r.procentaj_emag == null ? DEFAULT_PROCENTAJ_EMAG : Number(r.procentaj_emag),
    };
    if (!calcProduct(input, params)) {
      skipped.push(r);
      continue;
    }
    const old = r.sale_price == null ? null : Number(r.sale_price);
    const oldPct = old ? pctTren(input, params, old) : null;
    if (oldPct != null && oldPct >= MIN - EPS) {
      unchanged++;
      continue;
    }
    const next = minPrice99(input, params);
    if (next == null) {
      skipped.push(r);
      continue;
    }
    changes.push({
      id: r.id,
      name: r.name,
      old,
      next,
      oldPct,
      newPct: pctTren(input, params, next),
      overMax: r.max_sale_price != null && next > Number(r.max_sale_price) ? Number(r.max_sale_price) : null,
    });
  }

  const f = (x) => (x == null ? "—" : x.toFixed(2));
  const p = (x) => (x == null ? "—" : (x * 100).toFixed(1) + "%");
  for (const c of changes) {
    console.log(
      `#${c.id}\t${f(c.old)} -> ${f(c.next)}\t${p(c.oldPct)} -> ${p(c.newPct)}` +
        `${c.overMax != null ? `\tPESTE MAX (${f(c.overMax)})` : ""}\t${(c.name || "").slice(0, 60)}`
    );
  }
  console.log(`\nDe modificat: ${changes.length}, deja >= ${MIN * 100}%: ${unchanged}, sarite (fara cost): ${skipped.length}`);
  console.log(`Peste max_sale_price: ${changes.filter((c) => c.overMax != null).length}`);
  if (skipped.length) {
    console.log("\nSarite (lipsa pret fabrica/greutate):");
    for (const r of skipped) console.log(`#${r.id}\t${f(r.sale_price == null ? null : Number(r.sale_price))}\t${(r.name || "").slice(0, 60)}`);
  }

  if (APPLY && changes.length) {
    const now = new Date().toISOString();
    await withTransaction(async (client) => {
      for (const c of changes) {
        await client.query(
          "UPDATE catalog_products SET sale_price = $1, updated_at = $2 WHERE id = $3",
          [c.next, now, c.id]
        );
      }
    });
    console.log(`\nAPLICAT: ${changes.length} preturi actualizate.`);
  } else if (!APPLY) {
    console.log("\nDry-run (nimic salvat). Ruleaza cu --apply ca sa salvezi.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => endPool());
