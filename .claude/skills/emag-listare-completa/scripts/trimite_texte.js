// TRIMITE TITLUL ȘI DESCRIEREA PE eMAG HU/BG — DOAR când utilizatorul a spus explicit „trimite pe eMAG” pentru ACEST produs.
// Aplicația nu are titlu/descriere pe HU/BG („Publică” trimite doar pe RO), deci textele pleacă direct pe platforma respectivă.
// Citește oferta de pe platformă (product_offer/read) și o retrimite COMPLETĂ (product_offer/save) cu valorile ei
// (prețul în HUF/BGN, stocul, caracteristicile, pozele), înlocuind DOAR name și description.
// Uz: docker cp trimite_texte.js emag-back:/tmp/ && docker cp texte_hu_bg.json emag-back:/tmp/
//     docker exec -w /app emag-back node /tmp/trimite_texte.js <offer_id> hu,bg /tmp/texte_hu_bg.json [send]
//   texte_hu_bg.json: {"hu": {"name": "...", "description": "text simplu, bullets cu „- ”"}, "bg": {...}}
//   (descrierea e text simplu, ca în aplicație; se transformă în HTML cu textToHtml, la fel ca la „Publică”)
//   fără „send” = DRY-RUN (arată înainte/după); cu „send” salvează, apoi recitește și confirmă.
const fs = require("fs");
const { emagFetch, emagApiBase, loadCredentials, authHeader, authCandidates } = require("/app/emag-client");
const { htmlToText, textToHtml } = require("/app/description-format");
const [oidS, platS, file, mode] = process.argv.slice(2);
// eMAG întoarce descrierea cu entități HTML (&eacute;, &#337;, &Oslash;): le decodăm înainte de comparare.
const L1 = "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const NAMED = Object.assign(Object.fromEntries(L1.map((n, i) => [n, String.fromCharCode(192 + i)])),
  { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", deg: "°", ndash: "–", mdash: "—", hellip: "…", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", laquo: "«", raquo: "»", middot: "·", times: "×" });
const decode = (t) => String(t || "").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&([a-z]+);/gi, (m, n) => NAMED[n] ?? m);
const plain = (html) => decode(htmlToText(html || "")).replace(/\s+/g, " ").trim();
const SEND = mode === "send";
const oid = Number(oidS);
async function call(base, auth, ep, data) {
  const r = await emagFetch(`${base}/${ep}`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ data }) });
  return { status: r.status, json: JSON.parse(await r.text()) };
}
(async () => {
  const texts = JSON.parse(fs.readFileSync(file, "utf8"));
  const creds = await loadCredentials();
  let failed = false;
  for (const platform of platS.split(",")) {
    const t = texts[platform];
    if (!t || !t.name || !t.description) { console.log(`[${platform}] lipsesc name/description în ${file}`); failed = true; continue; }
    const base = emagApiBase(platform);
    let auth;
    for (const c of authCandidates(creds)) { auth = authHeader(c.user, c.pass); const r = await call(base, auth, "product_offer/read", { id: oid }); if (r.status !== 401 && r.status !== 403) break; }
    const p = ((await call(base, auth, "product_offer/read", { id: oid })).json.results || [])[0];
    if (!p) { console.log(`[${platform}] oferta ${oid} nu există pe eMAG ${platform.toUpperCase()}`); failed = true; continue; }
    if (!p.ownership) { console.log(`[${platform}] nu suntem proprietarii documentației — eMAG nu acceptă titlu/descriere de la noi`); failed = true; continue; }
    const name = String(t.name).trim();
    const description = textToHtml(String(t.description).trim());
    console.log(`[${platform}] TITLU ÎNAINTE: ${p.name}`);
    console.log(`[${platform}] TITLU DUPĂ:    ${name} (${name.length} caractere)`);
    console.log(`[${platform}] DESCRIERE ÎNAINTE (${plain(p.description).length} caractere): ${plain(p.description).slice(0, 200)}…`);
    console.log(`[${platform}] DESCRIERE DUPĂ (${htmlToText(description).length} caractere): ${htmlToText(description).slice(0, 200).replace(/\n/g, " ")}…`);
    if (!SEND) { console.log(`[${platform}] DRY-RUN — nimic trimis.`); continue; }
    const payload = {
      id: p.id, category_id: p.category_id, name, part_number: p.part_number, brand: p.brand,
      description, images: (p.images || []).map((i) => ({ display_type: i.display_type, url: i.url })),
      characteristics: (p.characteristics || []).map((c) => ({ id: c.id, value: c.value })),
      ean: p.ean, sale_price: p.sale_price, min_sale_price: p.min_sale_price, max_sale_price: p.max_sale_price,
      vat_id: p.vat_id, status: p.status,
      stock: (p.stock || []).map((s) => ({ warehouse_id: Number(s.warehouse_id) || 1, value: s.value })),
      handling_time: (p.handling_time || []).map((h) => ({ warehouse_id: Number(h.warehouse_id) || 1, value: h.value })),
    };
    if (p.recommended_price) payload.recommended_price = p.recommended_price;
    if (p.warranty != null) payload.warranty = p.warranty;
    if (p.family && p.family.id) payload.family = { id: p.family.id, name: p.family.name, family_type_id: p.family.family_type_id };
    const r = await call(base, auth, "product_offer/save", [payload]);
    console.log(`[${platform}] SAVE`, r.status, "isError=" + r.json.isError, JSON.stringify(r.json.messages || []));
    if (r.json.isError) { failed = true; continue; }
    const q = ((await call(base, auth, "product_offer/read", { id: oid })).json.results || [])[0] || {};
    const v = (q.validation_status || [])[0] || {};
    const errs = ((v.errors && v.errors.errors) || []).map((e) => `${e.code}: ${(e.message && e.message.ro_RO) || ""}`);
    console.log(`[${platform}] RECITIT: titlu ${q.name === name ? "OK" : `DIFERIT („${q.name}”)`}, descriere ${plain(q.description) === plain(description) ? "OK" : "DIFERITĂ"}`,
      `| validare: ${v.value} ${v.description}`);
    if (errs.length) { console.log(`[${platform}] RESPINS de eMAG (textul nu ajunge pe site):`, errs.join(" | ")); failed = true; }
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
