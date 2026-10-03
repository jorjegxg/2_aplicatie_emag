// DOAR CITIRE: product_offer/read pentru unul sau mai multe offer id. Nu scrie nimic pe eMAG.
// Uz:  docker cp emag_oferta_citeste.js emag-back:/tmp/ && docker exec -w /app emag-back node /tmp/emag_oferta_citeste.js 56 57 58
const { emagFetch, EMAG_API, loadCredentials, authHeader, authCandidates } = require("/app/emag-client");
async function call(auth, ep, data) {
  const r = await emagFetch(`${EMAG_API}/${ep}`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ data }) });
  return { status: r.status, json: JSON.parse(await r.text()) };
}
(async () => {
  const ids = process.argv.slice(2).map(Number);
  const creds = await loadCredentials();
  let auth;
  for (const c of authCandidates(creds)) { auth = authHeader(c.user, c.pass); const t = await call(auth, "product_offer/read", { id: ids[0] }); if (t.status !== 401 && t.status !== 403) break; }
  for (const id of ids) {
    const p = (await call(auth, "product_offer/read", { id })).json.results[0];
    if (!p) { console.log(id, "NU EXISTĂ"); continue; }
    console.log(JSON.stringify({ id, part_number: p.part_number, pnk: p.part_number_key, category_id: p.category_id, name: p.name, sale_price: p.sale_price,
      status: p.status, family: p.family, images: (p.images || []).map(i => i.url), characteristics: (p.characteristics || []).map(c => `${c.id}=${c.value}`),
      validation: p.offer_validation_status }, null, 1));
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
