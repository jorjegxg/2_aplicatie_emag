/*
 * Ridica pretul de vanzare (catalog_products.sale_price) la produsele cu % profit Tren/Mare
 * sub prag, la cel mai mic pret terminat in ,99 care atinge pragul. Restul raman neschimbate.
 * Foloseste acelasi calcul ca tabelul (calculator.js, comision implicit 25% ca in app.js).
 * Salveaza si PRP / pret minim / pret maxim derivate din pret (ca schedulePersistDerived in app.js).
 * Rulare: node scripts/raise-prices-min-profit.js [--apply] [--min=20]
 *         node scripts/raise-prices-min-profit.js --derived-only --ids=1,2,3 [--apply]
 */
const { query, withTransaction, endPool } = require("../pg");
const { calcProduct } = require("../calculator");

const APPLY = process.argv.includes("--apply");
const minArg = process.argv.find((a) => a.startsWith("--min="));
const MIN = (minArg ? Number(minArg.slice(6)) : 20) / 100;
const DEFAULT_PROCENTAJ_EMAG = 25;
const EPS = 1e-9;
const DERIVED_ONLY = process.argv.includes("--derived-only");
const idsArg = process.argv.find((a) => a.startsWith("--ids="));
const IDS = idsArg ? idsArg.slice(6).split(",").map(Number).filter(Number.isFinite) : null;

const roundPrice = (n) => Math.round(n * 10000) / 10000;
const multOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Ca derivePrices + getRowPretMinim din app.js: pretul minim override ramane neschimbat. */
function derivedFor(sale, st, minOverride) {
  const m = (k) => multOrNull(st?.[k]);
  const d = (mult) => (mult == null ? null : roundPrice(sale * mult));
  return {
    recommended_price: d(m("mult_prp")),
    min_sale_price: minOverride != null ? Number(minOverride) : d(m("mult_min")),
    max_sale_price: d(m("mult_max")),
  };
}

async function updatePrices(client, id, sale, derived, now) {
  const set = ["sale_price = $1", "updated_at = $2"];
  const vals = [sale, now];
  for (const [k, v] of Object.entries(derived)) {
    if (v == null) continue;
    vals.push(v);
    set.push(`${k} = $${vals.length}`);
  }
  vals.push(id);
  await client.query(`UPDATE catalog_products SET ${set.join(", ")} WHERE id = $${vals.length}`, vals);
}

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
  const { rows: st } = await query(
    "SELECT calculator_params, mult_prp, mult_min, mult_max FROM settings WHERE id = 1"
  );
  const params = st[0]?.calculator_params || null;
  if (DERIVED_ONLY) return derivedOnly(st[0]);

  const { rows } = await query(`
    SELECT c.id, c.emag_offer_id, c.nume AS name, c.sale_price, c.max_sale_price,
           ml.pret_minim_override,
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
      derived: derivedFor(next, st[0], r.pret_minim_override),
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
        await updatePrices(client, c.id, c.next, c.derived, now);
      }
    });
    console.log(`\nAPLICAT: ${changes.length} preturi actualizate.`);
  } else if (!APPLY) {
    console.log("\nDry-run (nimic salvat). Ruleaza cu --apply ca sa salvezi.");
  }
}

/** Doar PRP / min / max din pretul de vanzare curent, pentru produsele din --ids. */
async function derivedOnly(st) {
  if (!IDS || IDS.length === 0) throw new Error("--derived-only cere --ids=1,2,3");
  const { rows } = await query(
    `SELECT c.id, c.sale_price, c.recommended_price, c.min_sale_price, c.max_sale_price,
            ml.pret_minim_override
     FROM catalog_products c
     LEFT JOIN marketplace_listings ml
       ON ml.channel = 'emag' AND ml.external_id = c.emag_offer_id
     WHERE c.id = ANY($1::int[]) AND c.sale_price IS NOT NULL
     ORDER BY c.id`,
    [IDS]
  );
  const f = (x) => (x == null ? "—" : Number(x).toFixed(4));
  const items = rows.map((r) => ({
    r,
    sale: Number(r.sale_price),
    derived: derivedFor(Number(r.sale_price), st, r.pret_minim_override),
  }));
  for (const { r, sale, derived } of items) {
    console.log(
      `#${r.id}\tpret ${sale.toFixed(2)}\tPRP ${f(r.recommended_price)} -> ${f(derived.recommended_price)}` +
        `\tmin ${f(r.min_sale_price)} -> ${f(derived.min_sale_price)}\tmax ${f(r.max_sale_price)} -> ${f(derived.max_sale_price)}`
    );
  }
  console.log(`\nProduse: ${items.length} (din ${IDS.length} id-uri)`);
  if (!APPLY) {
    console.log("Dry-run (nimic salvat). Ruleaza cu --apply ca sa salvezi.");
    return;
  }
  const now = new Date().toISOString();
  await withTransaction(async (client) => {
    for (const { r, sale, derived } of items) await updatePrices(client, r.id, sale, derived, now);
  });
  console.log(`APLICAT: ${items.length} produse actualizate.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => endPool());
