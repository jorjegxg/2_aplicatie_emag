// TRIMITE POZELE PE eMAG — DOAR când utilizatorul a spus explicit „trimite pe eMAG” pentru ACEST produs.
// Aceeași logică ca POST /api/catalog/product/:id/images/push (backend/server.js), rulată în container.
// Uz: docker cp trimite_poze.js emag-back:/tmp/ && docker exec -w /app emag-back node /tmp/trimite_poze.js <product_id> [ro,hu,bg] [send]
//   fără „send” = DRY-RUN: arată ce s-ar trimite (număr poze, URL-uri, status HTTP al fiecărui URL public).
//   cu „send”: pushImages + markImagesPushed, apoi recitește oferta pe fiecare platformă și compară numărul de poze.
const pi = require("/app/product-images.js");
const db = require("/app/marketplace-db.js");
const { getChannel } = require("/app/channels");
const { emagFetch, emagApiBase, loadCredentials, authHeader, authCandidates } = require("/app/emag-client");
const [pidS, platS = "ro,hu,bg", mode] = process.argv.slice(2);
const pid = Number(pidS);
const SEND = mode === "send";
async function readOffer(platform, offerId) {
  const creds = await loadCredentials();
  for (const c of authCandidates(creds)) {
    const r = await emagFetch(`${emagApiBase(platform)}/product_offer/read`, { method: "POST", headers: { Authorization: authHeader(c.user, c.pass), "Content-Type": "application/json" }, body: JSON.stringify({ data: { id: offerId } }) });
    if (r.status === 401 || r.status === 403) continue;
    const j = JSON.parse(await r.text());
    return j.results && j.results[0];
  }
  return null;
}
(async () => {
  const offerId = await db.getProductOfferId(pid);
  if (!offerId) throw new Error("Produsul nu are emag_offer_id");
  for (const platform of platS.split(",")) {
    const eff = await pi.effectiveImages(pid, platform);
    const urls = eff.images.map((img) => pi.absoluteUrl(img.stored_name));
    const codes = [];
    for (const u of urls) { try { codes.push((await fetch(u, { method: "GET" })).status); } catch (e) { codes.push("ERR"); } }
    console.log(`[${platform}] sursa=${eff.source} poze=${urls.length} HTTP=${codes.join(",")}`);
    if (codes.some((c) => c !== 200)) { console.log(`[${platform}] OPRIT: nu toate URL-urile publice răspund 200`); continue; }
    if (!SEND) continue;
    const pushed = await getChannel("emag").pushImages(platform, [{ offerId, images: urls.map((url) => ({ url })) }]);
    await pi.markImagesPushed(pid, platform, pi.imagesStamp(eff));
    console.log(`[${platform}] push ok`, JSON.stringify(pushed.messages || []));
    const o = await readOffer(platform, offerId);
    console.log(`[${platform}] recitit: ${o ? (o.images || []).length : "?"} poze pe eMAG (așteptat ${urls.length})`);
  }
  if (!SEND) console.log("DRY-RUN — nimic trimis. Adaugă „send” ca ultim argument după confirmarea utilizatorului.");
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
