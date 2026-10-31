/**
 * Uneltele boților (server MCP în proces). Toate doar citesc: catalog, Base, eMAG, Trendyol, poze, căutări
 * și Chrome-ul boților de pe PC (browser_*, unde orice trimitere de date e blocată în browser.js).
 * Nu există nicio unealtă care să scrie în Base / eMAG / Trendyol.
 */
const { query } = require("../pg");
const surse = require("./surse");
const poze = require("./poze");
const browser = require("./browser");

const json = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 1).slice(0, 60_000) }] });
const fail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

/** Produsul fără descrierile lungi (le scurtăm, ca să încapă mai multe în context). */
function compact(p, { descriere = 600 } = {}) {
  const texte = {};
  for (const [lang, t] of Object.entries(p.texte || {})) {
    texte[lang] = {
      titlu: t?.name || null,
      descriere: t?.description ? String(t.description).slice(0, descriere) : null,
    };
  }
  const platform = (o) => (o ? { ...o, poze: o.poze?.length ?? 0 } : o === undefined ? "necitit" : "lipsă");
  return {
    id: p.id,
    cod: p.cod,
    pnk: p.pnk,
    ean: p.ean,
    texte,
    base: p.base ? { ...p.base, poze: p.base.poze?.length ?? 0 } : "nelegat",
    emag_ro: platform(p.emag.ro),
    emag_hu: platform(p.emag.hu),
    emag_bg: platform(p.emag.bg),
    trendyol: platform(p.trendyol),
  };
}

/**
 * → { config, names, cleanup } pentru brain.ask({ server }); cleanup închide tabul cererii. Câte o instanță nouă pe cerere: serverul SDK se
 * leagă de o singură sesiune, iar boții și conversațiile pot rula în paralel.
 */
async function server() {
  const { tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  const { z } = await import("zod");
  const tab = new browser.Tab();
  const page = (fn) => async (args) => {
    try {
      return json(await fn(args));
    } catch (e) {
      return fail(`Browserul: ${e.message.split("\n")[0]}`);
    }
  };
  const tools = [
    tool(
      "cauta_produs",
      "Caută produse în catalog după cod, nume, EAN, PNK sau id. Întoarce produsele găsite, cu datele de pe toate platformele.",
      { text: z.string().describe("ce cauți, de ex. „ORG-PORT”, „husa volan”, „D6DPJF2BM”") },
      async ({ text }) => {
        const found = await surse.findProducts(text);
        return found.length
          ? json(found.map((p) => compact(p, { descriere: 300 })))
          : fail(`Nimic găsit pentru „${text}”`);
      },
    ),
    tool(
      "produs",
      "Tot ce știm despre un produs (după id-ul din catalog): texte RO/HU/BG, Base, eMAG RO/HU/BG (preț, stoc, activ, validare, linkuri poze), Trendyol.",
      { id: z.number().int() },
      async ({ id }) => {
        const s = await surse.snapshot();
        const p = s.produse.find((x) => x.id === id);
        if (!p) return fail(`Nu există produsul ${id}`);
        const full = compact(p, { descriere: 4000 });
        full.linkuri_poze = {
          base: p.base?.poze || [],
          emag_ro: p.emag.ro?.poze || [],
          emag_hu: p.emag.hu?.poze || [],
          emag_bg: p.emag.bg?.poze || [],
          trendyol: p.trendyol?.poze || [],
        };
        return json(full);
      },
    ),
    tool(
      "lista_produse",
      "Lista scurtă a tuturor produselor: id, cod, titlu RO și prețul/stocul pe fiecare platformă.",
      {},
      async () => {
        const s = await surse.snapshot();
        const short = (o) =>
          o
            ? `${o.pret ?? "?"} ${o.moneda || ""} / stoc ${o.stoc ?? "?"}${o.activ === false ? " / inactiv" : ""}`
            : o === undefined
              ? "necitit"
              : "lipsă";
        return json({
          citit_la: s.la,
          erori: s.erori,
          produse: s.produse.map((p) => ({
            id: p.id,
            cod: p.cod,
            titlu: p.texte?.ro?.name || p.nume,
            base: p.base ? `${p.base.pret ?? "?"} RON / stoc ${p.base.stoc ?? "?"}` : "nelegat",
            emag_ro: short(p.emag.ro),
            emag_hu: short(p.emag.hu),
            emag_bg: short(p.emag.bg),
            trendyol: short(p.trendyol),
          })),
        });
      },
    ),
    tool(
      "masoara_poza",
      "Măsoară o poză după link: rezoluție, raport laturi, claritate (sub ~60 = moale), fundal alb (0..1), mărime.",
      { url: z.string() },
      async ({ url }) => json(await poze.analyze(url)),
    ),
    tool(
      "vezi_poza",
      "Îți arată poza (redusă la 1000 px) ca s-o poți judeca: se vede bine produsul? text lizibil? fundal? Folosește-o cu măsură, cel mult câteva poze odată.",
      { url: z.string() },
      async ({ url }) => {
        try {
          const buf = await poze.preview(url);
          return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }] };
        } catch (e) {
          return fail(`Nu pot deschide poza: ${e.message}`);
        }
      },
    ),
    tool(
      "cautari_salvate",
      "Ce a văzut botul SEO la căutări pe eMAG (sugestii, număr de rezultate, categorii, primii concurenți), cele mai noi întâi.",
      { termen: z.string().optional().describe("filtru, gol = ultimele căutări") },
      async ({ termen }) => {
        const { rows } = await query(
          `SELECT termen, platforma, sugestii, nr_rezultate, categorii, top, vazut_la FROM boti_keywords
                WHERE $1::text IS NULL OR termen ILIKE '%' || $1 || '%' ORDER BY vazut_la DESC LIMIT 30`,
          [termen || null],
        );
        return json(rows);
      },
    ),
    tool(
      "cauta_pe_emag",
      "Deschide căutarea eMAG pentru un termen, ca un cumpărător: număr de rezultate, categorii, primii concurenți, sugestii. Poate întoarce blocat=true dacă eMAG refuză browserul automat.",
      { termen: z.string(), tara: z.enum(["ro", "hu", "bg"]).default("ro") },
      async ({ termen, tara }) => {
        try {
          return json(await browser.search(termen, tara));
        } catch (e) {
          return fail(`Căutarea nu a mers: ${e.message}`);
        }
      },
    ),
    tool(
      "browser_deschide",
      "Deschide orice adresă în Chrome-ul boților (pe PC-ul proprietarului, cu logările lui): eMAG, Google, Trendyol, site-uri de concurenți. Întoarce titlul, textul paginii și linkurile. Doar citești: formularele și orice trimitere de date sunt blocate.",
      { url: z.string().describe("de ex. https://www.google.ro/search?q=husa+volan sau https://www.emag.ro/search/husa%20volan") },
      page(({ url }) => tab.open(url)),
    ),
    tool(
      "browser_click",
      "Click pe un link sau buton din pagina deschisă, după textul lui (sau un selector CSS). Întoarce pagina nouă.",
      { tinta: z.string().describe("textul linkului / butonului, de ex. „Următoarea pagină”") },
      page(({ tinta }) => tab.click(tinta)),
    ),
    tool(
      "browser_cauta_in_pagina",
      "Scrie în bara de căutare a site-ului deschis și apasă Enter (de ex. pe Google sau Trendyol). Întoarce rezultatele.",
      { text: z.string() },
      page(({ text }) => tab.searchHere(text)),
    ),
    tool(
      "browser_inapoi",
      "Înapoi la pagina anterioară.",
      {},
      page(() => tab.back()),
    ),
    tool(
      "browser_captura",
      "Captură a ce se vede acum în tab, ca să judeci aspectul (poze, poziția produsului în listă). Folosește-o cu măsură.",
      {},
      async () => {
        try {
          const buf = await tab.screenshot();
          return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }] };
        } catch (e) {
          return fail(`Browserul: ${e.message.split("\n")[0]}`);
        }
      },
    ),
  ];
  return {
    config: createSdkMcpServer({ name: "date", version: "1.0.0", tools }),
    names: tools.map((t) => t.name),
    cleanup: () => tab.close(),
  };
}

module.exports = { server, compact };
