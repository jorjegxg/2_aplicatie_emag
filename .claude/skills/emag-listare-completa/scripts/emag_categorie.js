// DOAR CITIRE: category/read -> caracteristicile categoriei cu valorile PERMISE (folosește-le exact așa, ex. „Geamuri auto”, nu „Geamuri”).
// Uz: docker cp emag_categorie.js emag-back:/tmp/ && docker exec -w /app emag-back node /tmp/emag_categorie.js 1422
//     docker cp emag-back:/tmp/categorie_1422.json <scratchpad>/   (clientul eMAG scrie loguri pe stdout, de aceea ieșirea merge în fișier)
// Ieșire: JSON {id, name, characteristics:[{id,name,is_mandatory,type_id,allow_new_value,values:[...]}]}
const { emagFetch, EMAG_API, loadCredentials, authHeader, authCandidates } = require("/app/emag-client");
async function call(auth, ep, data) {
  const r = await emagFetch(`${EMAG_API}/${ep}`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ data }) });
  return { status: r.status, json: JSON.parse(await r.text()) };
}
(async () => {
  const cid = Number(process.argv[2]);
  const creds = await loadCredentials();
  let r;
  for (const c of authCandidates(creds)) { r = await call(authHeader(c.user, c.pass), "category/read", { id: cid }); if (r.status !== 401 && r.status !== 403) break; }
  const cat = r.json.results[0];
  const out = { id: cid, name: cat.name, characteristics: (cat.characteristics || []).map(ch => ({ id: ch.id, name: ch.name, is_mandatory: ch.is_mandatory, type_id: ch.type_id,
    allow_new_value: ch.allow_new_value, values: (ch.values || []).map(v => (v && typeof v === "object") ? (v.name ?? v.value) : v) })) };
  const f = "/tmp/categorie_" + cid + ".json";
  require("fs").writeFileSync(f, JSON.stringify(out));
  console.log("scris", f, "-", out.name, "-", out.characteristics.length, "caracteristici");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
