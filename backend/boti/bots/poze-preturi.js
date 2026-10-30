/**
 * „Vitrina”: pozele pe fiecare platformă (rupte, mici, moi, fără fundal alb, altă poză principală decât în Base)
 * și prețul față de concurența de pe eMAG. Ia câte `max_produse` la rând, de unde a rămas data trecută.
 */
const { query } = require("../../pg");
const surse = require("../surse");
const poze = require("../poze");
const browser = require("../browser");
const { REPORT_SCHEMA, systemPrompt } = require("./common");

const MIN_SIDE = 1000;
// Praguri orientative (măsurate pe pozele din R2): blur ușor coboară claritatea sub ~100, mărirea dintr-o poză mică coboară detaliul sub ~8.
const SOFT = 100;
const LOW_DETAIL = 8;
const SAME_PHOTO = 12; // distanța dHash sub care e aceeași poză
const PRICE_CHECKS = 3;

async function cursor(botId, n, total) {
  const key = `cursor:${botId}`;
  const { rows } = await query(`SELECT valoare FROM boti_setari WHERE cheie = $1`, [key]);
  const start = Number(rows[0]?.valoare) || 0;
  const next = total ? (start + n) % total : 0;
  await query(
    `INSERT INTO boti_setari (cheie, valoare, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (cheie) DO UPDATE SET valoare = EXCLUDED.valoare, updated_at = now()`,
    [key, String(next)]
  );
  return start % Math.max(1, total);
}

function issues(m, { main }) {
  const out = [];
  if (!m.ok) return [`poza nu se deschide (${m.eroare})`];
  if (Math.min(m.latime, m.inaltime) < MIN_SIDE) out.push(`mică: ${m.latime}x${m.inaltime}`);
  if (m.raport && Math.abs(m.raport - 1) > 0.05) out.push(`nu e pătrată (${m.latime}x${m.inaltime})`);
  if (m.claritate < SOFT) out.push(`posibil moale / neclară (claritate ${m.claritate})`);
  else if (m.detaliu < LOW_DETAIL) out.push(`posibil mărită dintr-o poză mică (detaliu ${m.detaliu})`);
  if (main && m.fundal_alb < 0.5) out.push(`poza principală fără fundal alb (${m.fundal_alb})`);
  return out;
}

async function checkProduct(p) {
  const platforms = { Base: p.base?.poze, "eMAG RO": p.emag.ro?.poze, "eMAG HU": p.emag.hu?.poze, "eMAG BG": p.emag.bg?.poze, Trendyol: p.trendyol?.poze };
  const res = { produs_id: p.id, produs: p.texte?.ro?.name || p.nume, cod: p.cod, pnk: p.pnk, platforme: {} };
  const baseMain = p.base?.poze?.[0] ? await poze.analyze(p.base.poze[0]) : null;
  for (const [label, list] of Object.entries(platforms)) {
    if (!list) continue;
    const entry = { numar: list.length, probleme: [], poze: [] };
    // Base = galeria sursă: o măsurăm toată; pe platforme doar poza principală (și o comparăm cu Base).
    const urls = label === "Base" ? list : list.slice(0, 1);
    for (const [i, url] of urls.entries()) {
      const m = label === "Base" && i === 0 && baseMain ? baseMain : await poze.analyze(url);
      const probs = issues(m, { main: i === 0 });
      if (probs.length) entry.probleme.push(...probs.map((x) => `poza ${i + 1}: ${x}`));
      entry.poze.push({ url, ...m, hash: undefined });
      if (label !== "Base" && i === 0 && m.ok && baseMain?.ok) {
        const d = poze.hashDistance(m.hash, baseMain.hash);
        if (d > SAME_PHOTO) entry.probleme.push(`poza principală e alta decât în Base (diferență ${d}/64)`);
      }
    }
    if (list.length < 4) entry.probleme.push(`doar ${list.length} poze`);
    res.platforme[label] = entry;
  }
  return res;
}

async function run({ bot, signal, progres, ask }) {
  const max = Math.max(1, Number(bot.setari?.max_produse) || 15);
  progres("citesc produsele");
  const s = await surse.snapshot();
  const all = s.produse.filter((p) => p.base && !p.base.lipsa);
  const start = await cursor(bot.id, max, all.length);
  const batch = [...all, ...all].slice(start, start + Math.min(max, all.length));

  const rezultate = [];
  for (const [i, p] of batch.entries()) {
    if (signal.aborted) break;
    progres(`poze ${i + 1}/${batch.length}: ${p.cod}`);
    rezultate.push(await checkProduct(p));
  }

  // Prețul față de concurență, din căutarea eMAG (poate fi blocată de site).
  const preturi = [];
  let blocat = false;
  for (const p of batch.slice(0, PRICE_CHECKS)) {
    if (signal.aborted || blocat) break;
    const termen = String(p.texte?.ro?.name || p.nume || "").split(/[,(]/)[0].split(/\s+/).slice(0, 5).join(" ");
    progres(`concurență pe eMAG: ${termen}`);
    try {
      const r = await browser.search(termen, "ro");
      if (r.blocat) blocat = true;
      else preturi.push({ produs_id: p.id, termen, pretul_meu: p.emag.ro?.pret ?? p.base?.pret, concurenti: r.top.slice(0, 10) });
    } catch (e) {
      preturi.push({ produs_id: p.id, termen, eroare: e.message });
    }
  }

  progres("Claude se uită la rezultate");
  const prompt = `Am verificat pozele la ${rezultate.length} produse (de la poziția ${start + 1} din ${all.length}).
Praguri (orientative, verifică vizual): latura minimă ${MIN_SIDE}px, claritate sub ${SOFT} = posibil moale, detaliu sub ${LOW_DETAIL} = posibil mărită, fundal alb sub 0.5 pe poza principală.
Rezultate (problemele găsite automat + măsurătorile):
${JSON.stringify(rezultate).slice(0, 80_000)}

Concurența pe eMAG România: ${blocat ? "eMAG a blocat browserul automat, deci nu am prețurile concurenților." : JSON.stringify(preturi).slice(0, 20_000)}

Ce vreau de la tine:
1. Uită-te cu vezi_poza la cel mult 6 poze suspecte (moi, fără fundal alb, altă poză principală) și spune ce se vede de fapt.
2. constatari: problemele reale (cel mult 25). Ignoră alarmele false pe care le vezi în poze.
3. Dacă ai prețurile concurenților, spune unde suntem mult mai scumpi sau mult mai ieftini.
4. text_vorbit: raportul de 1–2 minute.`;

  return ask({
    system: systemPrompt(bot, "Treaba ta: te uiți la poze pe fiecare platformă (se văd bine? sunt aceleași ca în Base? se deschid?) și la prețul față de concurență."),
    prompt,
    schema: REPORT_SCHEMA,
    tools: true,
    maxTurns: 25,
  });
}

module.exports = { id: "poze-preturi", run };
