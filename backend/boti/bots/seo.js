/**
 * „Căutătorul”: cum caută lumea produsele tale pe eMAG (sugestii, număr de rezultate, categorii, concurenți)
 * și ce cuvinte lipsesc din titlurile / descrierile tale. Rulează des, pe câte `max_produse` la rând.
 * Pe lângă căutările fixe, Claude folosește singur Chrome-ul boților (Google, concurenți, Trendyol).
 * Dacă eMAG refuză browserul, lucrează fără date live (titlurile tale, categoria Trendyol,
 * căutările salvate din rulările trecute) și spune asta în raport.
 */
const { query } = require("../../pg");
const surse = require("../surse");
const browser = require("../browser");
const { REPORT_SCHEMA, systemPrompt } = require("./common");

const STOP = new Set(["pentru", "de", "cu", "si", "și", "din", "la", "auto", "masina", "mașină", "set", "buc"]);

async function cursor(botId, n, total) {
  const key = `cursor:${botId}`;
  const { rows } = await query(`SELECT valoare FROM boti_setari WHERE cheie = $1`, [key]);
  const start = Number(rows[0]?.valoare) || 0;
  await query(
    `INSERT INTO boti_setari (cheie, valoare, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (cheie) DO UPDATE SET valoare = EXCLUDED.valoare, updated_at = now()`,
    [key, String(total ? (start + n) % total : 0)]
  );
  return start % Math.max(1, total);
}

/** Termenii de pornire din titlu: tipul de produs (primele cuvinte) și o variantă scurtă. */
function seeds(title) {
  const head = String(title || "").toLowerCase().split(/[,(]/)[0];
  const words = head.split(/\s+/).filter((w) => w.length > 1);
  const core = words.filter((w) => !STOP.has(w));
  return [...new Set([words.slice(0, 3).join(" "), core.slice(0, 2).join(" ")])].filter((t) => t.length > 3);
}

async function run({ bot, signal, progres, ask }) {
  const max = Math.max(1, Number(bot.setari?.max_produse) || 5);
  const tari = (bot.setari?.tari || ["ro"]).filter((t) => ["ro", "hu", "bg"].includes(t));
  const s = await surse.snapshot();
  const all = s.produse.filter((p) => p.texte?.ro?.name || p.nume);
  const start = await cursor(bot.id, max, all.length);
  const batch = [...all, ...all].slice(start, start + Math.min(max, all.length));

  let blocat = false;
  const produse = [];
  for (const [i, p] of batch.entries()) {
    if (signal.aborted) break;
    const titlu = p.texte?.ro?.name || p.nume;
    const entry = {
      produs_id: p.id,
      cod: p.cod,
      titlu_ro: titlu,
      descriere_ro: String(p.texte?.ro?.description || "").slice(0, 1500),
      titlu_hu: p.base?.titluri?.hu || p.emag.hu?.titlu || null,
      titlu_bg: p.base?.titluri?.bg || p.emag.bg?.titlu || null,
      categorie_trendyol: p.trendyol?.categorie || null,
      cautari: [],
    };
    for (const termen of seeds(titlu)) {
      for (const tara of tari) {
        if (signal.aborted || blocat) break;
        progres(`${i + 1}/${batch.length}: caut „${termen}” pe eMAG ${tara.toUpperCase()}`);
        try {
          const r = await browser.search(termen, tara);
          if (r.blocat) {
            blocat = true;
            break;
          }
          entry.cautari.push({ termen, tara, ...r });
          await query(
            `INSERT INTO boti_keywords (termen, platforma, sugestii, nr_rezultate, categorii, top) VALUES ($1, $2, $3, $4, $5, $6)`,
            [termen, `emag_${tara}`, JSON.stringify(r.sugestii), r.nr_rezultate, JSON.stringify(r.categorii), JSON.stringify(r.top.slice(0, 10))]
          );
        } catch (e) {
          entry.cautari.push({ termen, tara, eroare: e.message });
        }
      }
    }
    produse.push(entry);
  }

  const { rows: istoric } = await query(
    `SELECT termen, platforma, sugestii, nr_rezultate, categorii, vazut_la FROM boti_keywords ORDER BY vazut_la DESC LIMIT 40`
  );

  progres("Claude scrie propunerile");
  const prompt = `Analizează SEO pentru ${produse.length} produse (de la poziția ${start + 1} din ${all.length}).
${blocat ? "ATENȚIE: eMAG a refuzat browserul automat, deci nu am date live din căutare la această rulare. Lucrează cu titlurile, descrierile, categoria Trendyol, căutările salvate mai jos și cunoștințele tale despre cum caută românii; spune scurt în raport că datele live lipsesc." : "Am date live din căutarea eMAG (sugestii, număr de rezultate, categorii, titlurile primilor concurenți)."}

Produse:
${JSON.stringify(produse).slice(0, 80_000)}

Căutări salvate din rulările trecute:
${JSON.stringify(istoric).slice(0, 15_000)}

Ce vreau de la tine, pentru fiecare produs:
1. Ce cuvinte caută oamenii (și ce sinonime) care lipsesc din titlul sau descrierea mea; ce e în plus sau în ordine proastă. Primele ~50 de caractere ale titlului contează cel mai mult pe mobil.
2. În ce categorie pune eMAG căutarea (dacă știi) și dacă produsul pare în categoria potrivită.
3. O propunere de titlu RO (fără să inventezi caracteristici care nu apar în texte).
Ai browserul liber: pentru produsele unde datele de mai sus nu ajung, uită-te singur. De exemplu sugestiile Google când tastezi și „Oamenii caută și” (google.ro / .hu / .bg), pagina primului concurent de pe eMAG (titlu, caracteristici, ce scrie în descriere), cum se numește produsul pe Trendyol, căutări cu sinonime pe eMAG. Nu deschide mai mult de vreo 15 pagini în total.
În constatari: câte o constatare pe produs (problema = ce lipsește, sugestie = titlul propus + cuvintele de adăugat în descriere), gravitate după cât pierde produsul.
text_vorbit: 1–2 minute, cu cele mai valoroase 2–3 idei, fără să citești titlurile întregi.`;

  return ask({
    system: systemPrompt(bot, "Treaba ta: SEO pentru listări — ce caută oamenii pe eMAG, în ce categorii, și ce cuvinte să pună proprietarul în titluri și descrieri."),
    prompt,
    schema: REPORT_SCHEMA,
    tools: true,
    maxTurns: 40,
  });
}

module.exports = { id: "seo", run };
