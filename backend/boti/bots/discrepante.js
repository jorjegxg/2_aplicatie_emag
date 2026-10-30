/**
 * „Detectivul”: ce nu se potrivește între Base și platforme (eMAG RO/HU/BG, Trendyol).
 * Comparațiile se fac în cod (preț, stoc, oferte inactive / lipsă, titlu, număr de poze, validări),
 * apoi Claude le pune în ordine și le spune pe înțeles.
 */
const surse = require("../surse");
const { REPORT_SCHEMA, systemPrompt, plain } = require("./common");

const PRICE_TOL = 0.02; // RO: Base vs platformă
const FOREIGN_TOL = 0.2; // HU/BG: după cursul BCE, pot avea transport / adaos propriu
const MAX_FINDINGS = 200;
const LABEL = { ro: "eMAG RO", hu: "eMAG HU", bg: "eMAG BG" };
const CURRENCY = { hu: "HUF", bg: "EUR" };

let rates = null;
/** Cursul BCE → RON pentru 1 unitate: { EUR, HUF }. BNR nu mai are XML-ul vechi la adresa publică. */
async function fxRates() {
  if (rates && Date.now() - rates.at < 12 * 3600_000) return rates.v;
  try {
    const xml = await (await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", { signal: AbortSignal.timeout(15_000) })).text();
    const perEur = {};
    for (const m of xml.matchAll(/currency='([A-Z]{3})' rate='([\d.]+)'/g)) perEur[m[1]] = Number(m[2]);
    if (!perEur.RON) throw new Error("fără RON");
    const v = { EUR: perEur.RON };
    if (perEur.HUF) v.HUF = perEur.RON / perEur.HUF;
    rates = { at: Date.now(), v };
    return v;
  } catch {
    return rates?.v || {};
  }
}

function toRon(price, currency, fx) {
  if (price == null) return null;
  const c = String(currency || "RON").toUpperCase();
  if (c === "RON") return price;
  return fx[c] ? price * fx[c] : null;
}

const pct = (a, b) => (a == null || b == null || !b ? null : (a - b) / b);

function compare(p, fx) {
  const out = [];
  const name = p.texte?.ro?.name || p.nume || p.cod;
  const add = (platforma, problema, gravitate, date) => out.push({ produs_id: p.id, produs: name, cod: p.cod, platforma, problema, gravitate, date });
  const b = p.base;
  if (!b) {
    add("Base", "produsul nu e legat de Base", "medie");
    return out;
  }
  if (b.lipsa) {
    add("Base", "legat de un produs care nu mai există în Base", "mare");
    return out;
  }

  const platforms = [
    ...["ro", "hu", "bg"].map((pl) => [LABEL[pl], p.emag[pl], pl]),
    ["Trendyol", p.trendyol, "ty"],
  ];
  for (const [label, o, key] of platforms) {
    if (o === undefined) continue; // platforma nu s-a putut citi acum
    if (o === null) {
      add(label, "nu are ofertă", key === "ro" ? "medie" : "mica");
      continue;
    }
    // Preț
    if (key === "ro" || key === "ty") {
      const d = pct(o.pret, b.pret);
      if (d != null && Math.abs(d) > PRICE_TOL) add(label, `preț ${o.pret} RON față de ${b.pret} în Base (${Math.round(d * 100)}%)`, Math.abs(d) > 0.1 ? "mare" : "medie", { pret: o.pret, base: b.pret });
    } else {
      const ron = toRon(o.pret, o.moneda || CURRENCY[key], fx);
      const d = pct(ron, b.pret);
      if (d != null && Math.abs(d) > FOREIGN_TOL)
        add(label, `preț ${o.pret} ${o.moneda || CURRENCY[key]} ≈ ${Math.round(ron)} RON față de ${b.pret} RON în Base (${Math.round(d * 100)}%)`, Math.abs(d) > 0.4 ? "mare" : "medie", { pret: o.pret, moneda: o.moneda, ron: Math.round(ron), base: b.pret });
    }
    // Stoc
    if (b.stoc != null && o.stoc != null && Number(o.stoc) !== Number(b.stoc)) {
      add(label, `stoc ${o.stoc} față de ${b.stoc} în Base`, o.stoc > b.stoc ? "mare" : "medie", { stoc: o.stoc, base: b.stoc });
    }
    // Activă?
    if (o.activ === false && (b.stoc || 0) > 0) add(label, "oferta e inactivă deși ai stoc în Base", "mare");
    // Validare / respingeri
    if (o.validare && ["respins", "blocat"].includes(o.validare.grp)) {
      add(label, `validare ${o.validare.grp}: ${(o.validare.erori || []).join(", ") || o.validare.text || ""}`, o.validare.grp === "respins" ? "mare" : "medie");
    }
    if (o.respingeri?.length) add(label, `respins: ${o.respingeri.join("; ")}`, "mare");
    // Titlu
    const lang = key === "hu" ? "hu" : key === "bg" ? "bg" : "ro";
    const bt = b.titluri?.[lang];
    if (bt && o.titlu && plain(bt) !== plain(o.titlu)) add(label, `titlul diferă de Base`, "mica", { platforma: o.titlu, base: bt });
    // Poze
    const nb = b.poze?.length || 0;
    const np = o.poze?.length || 0;
    if (!np) add(label, "nu are nicio poză", "mare");
    else if (nb && np !== nb) add(label, `${np} poze față de ${nb} în Base`, "medie", { poze: np, base: nb });
  }
  return out;
}

async function run({ bot, signal, progres, ask }) {
  progres("citesc Base, eMAG și Trendyol");
  const s = await surse.snapshot({ fresh: true });
  if (signal.aborted) throw new Error("oprit");
  const fx = await fxRates();
  progres(`compar ${s.produse.length} produse`);
  const findings = s.produse.flatMap((p) => compare(p, fx));
  const order = { mare: 0, medie: 1, mica: 2 };
  findings.sort((a, b) => order[a.gravitate] - order[b.gravitate]);

  const counts = findings.reduce((acc, f) => ((acc[f.gravitate] = (acc[f.gravitate] || 0) + 1), acc), {});
  progres(`${findings.length} nepotriviri, le pun în ordine`);
  const prompt = `Am comparat ${s.produse.length} produse între Base (sursa de adevăr: prețul RO, stocul, titlurile, pozele) și eMAG RO/HU/BG + Trendyol.
Cursuri BCE folosite (RON pentru 1 unitate): ${JSON.stringify(fx && { EUR: fx.EUR, HUF: fx.HUF })}.
Surse care nu s-au putut citi: ${JSON.stringify(s.erori)}.
Nepotriviri găsite (${findings.length}: ${JSON.stringify(counts)}), primele ${MAX_FINDINGS}:
${JSON.stringify(findings.slice(0, MAX_FINDINGS))}

Ce vreau de la tine:
1. Verifică cu uneltele 2–3 cazuri care par ciudate, dacă e nevoie (nu toate).
2. constatari: cele mai importante probleme (cel mult 25), grupate unde se poate, cu sugestii concrete. Diferențele mici de preț pe HU/BG pot fi intenționate (transport, adaos) — spune-le doar dacă sunt mari.
3. text_vorbit: raportul de 1–2 minute, după regulile de vorbire.`;

  return ask({
    system: systemPrompt(bot, "Treaba ta: găsești ce nu se potrivește între Base și platforme — preț, stoc, oferte inactive sau lipsă, titluri, poze, validări."),
    prompt,
    schema: REPORT_SCHEMA,
    tools: true,
    maxTurns: 15,
  });
}

module.exports = { id: "discrepante", run };
