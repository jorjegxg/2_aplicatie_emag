// TRIMITE CARACTERISTICILE PE eMAG — DOAR când utilizatorul a spus explicit „trimite pe eMAG” pentru ACEST produs.
// Citește oferta (product_offer/read) și o retrimite COMPLETĂ (product_offer/save) așa cum e pe eMAG,
// înlocuind DOAR caracteristicile date. Valorile se validează contra listei permise (category/read).
// Uz: docker cp trimite_caracteristici.js emag-back:/tmp/ && docker cp schimbari.json emag-back:/tmp/
//     docker exec -w /app emag-back node /tmp/trimite_caracteristici.js <offer_id> /tmp/schimbari.json [send]
//   schimbari.json: {"5401": "Argintiu", "6556": ["1 x Odorizant auto solar elicopter", "1 x Tableta parfumata"]}
//   (multi-valoare = listă -> mai multe intrări cu același id)
//   fără „send” = DRY-RUN (arată diferențele și problemele); cu „send” salvează, apoi recitește și confirmă.
const fs = require("fs");
const { emagFetch, EMAG_API, loadCredentials, authHeader, authCandidates } = require("/app/emag-client");
const [oidS, file, mode] = process.argv.slice(2);
const SEND = mode === "send";
const oid = Number(oidS);
async function call(auth, ep, data) {
  const r = await emagFetch(`${EMAG_API}/${ep}`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ data }) });
  return { status: r.status, json: JSON.parse(await r.text()) };
}
(async () => {
  const changes = JSON.parse(fs.readFileSync(file, "utf8"));
  const creds = await loadCredentials();
  let auth;
  for (const c of authCandidates(creds)) { auth = authHeader(c.user, c.pass); const t = await call(auth, "product_offer/read", { id: oid }); if (t.status !== 401 && t.status !== 403) break; }
  const p = (await call(auth, "product_offer/read", { id: oid })).json.results[0];
  if (!p.ownership) throw new Error("Nu suntem proprietarii documentației — eMAG nu acceptă modificări de conținut");
  const cat = (await call(auth, "category/read", { id: p.category_id })).json.results[0];
  const problems = [], add = [];
  for (const [cid, raw] of Object.entries(changes)) {
    const def = (cat.characteristics || []).find((x) => String(x.id) === String(cid));
    if (!def) { problems.push(`${cid} nu e în categoria ${p.category_id}`); continue; }
    const allowed = (def.values || []).map((v) => (v && typeof v === "object" ? v.name ?? v.value : v));
    for (const v of [].concat(raw)) {
      let val = String(v);
      if (!def.allow_new_value) {
        const hit = allowed.find((x) => String(x).toLowerCase() === val.toLowerCase());
        if (!hit) { problems.push(`${cid} ${def.name} "${val}" NU e în lista permisă`); continue; }
        val = String(hit);
      }
      add.push({ id: Number(cid), value: val });
    }
  }
  const replaced = new Set(Object.keys(changes).map(String));
  const before = (p.characteristics || []).map((c) => `${c.id}=${c.value}`);
  const chars = (p.characteristics || []).filter((c) => !replaced.has(String(c.id))).map((c) => ({ id: c.id, value: c.value })).concat(add);
  console.log("ÎNAINTE:", before.join(" | "));
  console.log("DUPĂ:   ", chars.map((c) => `${c.id}=${c.value}`).join(" | "));
  if (problems.length) { console.log("PROBLEME:", problems.join("; ")); if (SEND) throw new Error("Oprit din cauza problemelor"); }
  if (!SEND) { console.log("DRY-RUN — nimic trimis."); process.exit(0); }
  const payload = {
    id: p.id, category_id: p.category_id, name: p.name, part_number: p.part_number, brand: p.brand,
    description: p.description, images: (p.images || []).map((i) => ({ display_type: i.display_type, url: i.url })),
    characteristics: chars, ean: p.ean, sale_price: p.sale_price, min_sale_price: p.min_sale_price, max_sale_price: p.max_sale_price,
    vat_id: p.vat_id, status: p.status,
    stock: (p.stock || []).map((s) => ({ warehouse_id: Number(s.warehouse_id) || 1, value: s.value })),
    handling_time: (p.handling_time || []).map((h) => ({ warehouse_id: Number(h.warehouse_id) || 1, value: h.value })),
  };
  if (p.recommended_price) payload.recommended_price = p.recommended_price;
  if (p.warranty != null) payload.warranty = p.warranty;
  if (p.family && p.family.id) payload.family = { id: p.family.id, name: p.family.name, family_type_id: p.family.family_type_id };
  const r = await call(auth, "product_offer/save", [payload]);
  console.log("SAVE", r.status, "isError=" + r.json.isError, JSON.stringify(r.json.messages || []));
  const q = (await call(auth, "product_offer/read", { id: oid })).json.results[0];
  const got = new Set((q.characteristics || []).map((c) => `${c.id}=${c.value}`));
  const missing = add.filter((a) => !got.has(`${a.id}=${a.value}`));
  console.log("RECITIT:", missing.length ? "LIPSESC " + missing.map((a) => `${a.id}=${a.value}`).join(", ") : "toate valorile sunt pe eMAG", "| validare:", JSON.stringify((q.validation_status || [])[0]));
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
