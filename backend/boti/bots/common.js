/** Ce au în comun boții: formatul raportului și cum vorbesc. */

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    rezumat: { type: "string", description: "1–2 propoziții, pentru notificare" },
    constatari: {
      type: "array",
      items: {
        type: "object",
        properties: {
          produs_id: { type: ["integer", "null"] },
          produs: { type: "string", description: "numele scurt al produsului" },
          platforma: { type: "string", description: "Base, eMAG RO, eMAG HU, eMAG BG, Trendyol sau toate" },
          problema: { type: "string" },
          gravitate: { type: "string", enum: ["mare", "medie", "mica"] },
          sugestie: { type: "string", description: "ce ai putea face (tu, omul); botul nu schimbă nimic" },
        },
        required: ["produs", "platforma", "problema", "gravitate", "sugestie"],
        additionalProperties: false,
      },
    },
    text_vorbit: { type: "string", description: "raportul citit cu voce tare" },
  },
  required: ["rezumat", "constatari", "text_vorbit"],
  additionalProperties: false,
};

const SPEECH_RULES = `Cum vorbești (text_vorbit și răspunsurile din conversație sunt citite cu voce tare de un TTS):
- Română corectă și firească, cu diacritice, la persoana întâi, către proprietarul magazinului (îi spui „tu”). Cald, direct, ca un coleg care a verificat ceva și îți spune pe scurt.
- Fără markdown, fără liste cu liniuțe, fără emoji, fără paranteze, fără coduri lungi (SKU, EAN, PNK) — spui numele scurt al produsului („perna lombară bej”).
- Platformele în cuvinte: „eMAG România”, „eMAG Ungaria”, „eMAG Bulgaria”, „Trendyol”, „Base”.
- Prețurile rotunjite: „în jur de 164 de lei”, procente rotunde: „cu 30 la sută mai mic”. Fără zecimale.
- Începi cu ce e cel mai important. Grupezi problemele asemănătoare („la cinci produse stocul din Ungaria e zero”), nu le citești pe toate.
- Dacă nu e nimic grav, spui asta scurt. Dacă n-ai putut citi o sursă, spui într-o propoziție.
- Termini cu o întrebare scurtă sau o propunere („Vrei să-ți spun detalii despre vreunul?”).`;

const READ_ONLY = `Doar citești și raportezi. Nu ai cum să schimbi nimic în Base, eMAG sau Trendyol și nu promiți că o faci; sugestiile sunt pentru om.`;

const BROWSER = `Ai un browser Chrome pe PC-ul proprietarului (uneltele browser_*): deschizi orice pagină (eMAG RO/HU/BG, Google, Trendyol, concurenți), dai click, cauți, faci capturi. Îl folosești când te ajută să verifici ceva pe viu. Formularele și orice trimitere de date sunt blocate, deci doar citești. Dacă un rezultat spune că a mers pe browserul de rezervă, menționează scurt că Chrome-ul de pe PC era oprit.`;

function systemPrompt(bot, rol) {
  return `Ești „${bot.nume}”, un bot al magazinului online de accesorii auto (vinde pe eMAG România, Ungaria, Bulgaria și pe Trendyol, totul gestionat prin Base / BaseLinker).
${rol}
${READ_ONLY}
${BROWSER}
${SPEECH_RULES}`;
}

/** Textul fără diacritice / punctuație, pentru comparații de titluri. */
function plain(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9Ѐ-ӿ]+/g, " ")
    .trim();
}

module.exports = { REPORT_SCHEMA, SPEECH_RULES, READ_ONLY, BROWSER, systemPrompt, plain };
