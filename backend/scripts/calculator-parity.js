/*
 * Verifica ca backend/calculator.js da aceleasi valori ca foaia ALL din Excel.
 * Citeste valorile calculate salvate in xlsx (cache-ul Excel) si le compara cu calcProduct.
 * Rulare: node scripts/calculator-parity.js [cale.xlsx]
 */
const path = require("path");
const XLSX = require("xlsx");
const { calcProduct, REGIMURI } = require("../calculator");

const file =
  process.argv[2] || path.join(__dirname, "..", "..", "FISIERE", "CALCULATOR INFINITE VENTURES.xlsx");
const ws = XLSX.readFile(file).Sheets.ALL;
const v = (addr) => ws[addr]?.v;

const EXCEL_REGIM = {
  "Impozit pe profit neplatitor de TVA": REGIMURI[0].value,
  "Impozit pe profit platitor de TVA": REGIMURI[1].value,
  "Microintreprindere (un angajat minim) neplatitor de TVA": REGIMURI[2].value,
  "Microintreprindere (un angajat minim) platitor de TVA": REGIMURI[3].value,
};
const regim = EXCEL_REGIM[String(v("A2") || "").trim()];
if (!regim) throw new Error(`Regim necunoscut in A2: ${v("A2")}`);

const pct = (x) => Number(x) * 100;
const params = {
  regim,
  curs_rmb: v("C8"),
  curs_usd: v("C9"),
  transport_aer_usd_kg: v("C11"),
  transport_tren_usd_kg: v("C13"),
  transport_fabrica_agent: pct(v("C17")),
  comision_agent: pct(v("C18")),
  tva: pct(v("C19")),
  taxe_vamale: pct(v("C20")),
  impozit_profit: pct(v("C21")),
  impozit_micro: pct(v("C21")),
  consumabile: v("C23"),
  curierat_contract: v("C26"),
  curierat_client: v("C29"),
};

const COLS = {
  G: "pret_achiz_china",
  I: "transport_aer",
  J: "transport_tren",
  K: "taxe_vamale_aer",
  L: "taxe_vamale_tren",
  M: "tva_import_aer",
  N: "tva_import_tren",
  O: "cost_final_aer",
  P: "cost_final_tren",
  Q: "diferenta_aer_tren",
  R: "cat_salvezi",
  U: "pret_vanzare_fara_tva",
  V: "comision_valoare",
  W: "comision_tva",
  X: "impozit_aer",
  Y: "impozit_tren",
  Z: "tva_colectat_aer",
  AA: "tva_colectat_tren",
  AB: "profit_aer",
  AC: "procent_profit_aer",
  AD: "profit_tren",
  AE: "procent_profit_tren",
  AF: "break_even_aer",
  AG: "break_even_tren",
  AI: "cost_comanda_aer",
  AJ: "cost_comanda_tren",
};

let rows = 0;
let failures = 0;
for (let r = 35; r < 1000; r++) {
  if (typeof v(`A${r}`) !== "number" || v(`F${r}`) == null) continue;
  rows++;
  const out = calcProduct(
    {
      pret_fabrica: v(`F${r}`),
      moneda: v(`E${r}`) === "RMB" ? "RMB" : "USD",
      greutate: v(`H${r}`),
      rotunjire_greutate: false, // in Excel H e introdusa manual, fara rotunjire
      pret_vanzare: v(`S${r}`),
      comision_emag: pct(v(`T${r}`)),
      nr_bucati: v(`AH${r}`),
    },
    params
  );
  for (const [col, key] of Object.entries(COLS)) {
    const expected = Number(v(`${col}${r}`));
    const actual = out?.[key];
    if (!Number.isFinite(expected)) continue;
    if (actual == null || Math.abs(actual - expected) > 1e-6) {
      failures++;
      console.log(`rand ${r} ${v(`B${r}`)} ${col} (${key}): excel=${expected} app=${actual}`);
    }
  }
}

console.log(`${rows} produse verificate, regim ${regim}, ${failures} diferente`);
process.exit(failures ? 1 : 0);
