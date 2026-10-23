/**
 * Repara pozele de pe eMAG RO/HU/BG: gaseste ofertele fara poze, cu mai putine poze
 * decat in aplicatie sau cu erori de poze (ex. DOWNLOAD_FAILED) si retrimite setul
 * propriu al platformei din aplicatie. Doar produsele care au poze proprii pe RO, HU
 * si BG; setul EN (de rezerva) nu se trimite.
 *
 * Reguli eMAG respectate:
 *  - o singura platforma in validare pe produs: daca o platforma e "pending" (ex. 11),
 *    produsul e sarit; pe rulare se trimite cel mult O platforma per produs (RO → HU → BG);
 *  - dupa un push, produsul asteapta COOLDOWN ore (din product_images_push_state.pushed_at).
 *
 * Se ruleaza prin scripts/repara-poze-emag.sh (verifica URL-urile de pe PC). Direct:
 *   node scripts/repara-poze-emag.js scan [--netrimise] [--cooldown 6] [--produs 45]
 *   node scripts/repara-poze-emag.js push [--url-uri-rele <fisier>|-]
 * Fisierele: /app/data/repara-poze/{plan.json,urls.txt,istoric.log}
 */
const fs = require("fs");
const path = require("path");
const { query, endPool } = require("../pg");
const { emagFetch, emagApiBase, loadCredentials, authHeader, authCandidates } = require("../emag-client");
const { getChannel } = require("../channels");
const {
  PUBLIC_BASE_URL,
  listByPlatformForProductIds,
  pickEffective,
  effectiveImages,
  imagesStamp,
  markImagesPushed,
  absoluteUrl,
} = require("../product-images");

const PLATFORMS = ["ro", "hu", "bg"];
const OUT_DIR = path.join(__dirname, "..", "data", "repara-poze");
const PLAN_FILE = path.join(OUT_DIR, "plan.json");
const URLS_FILE = path.join(OUT_DIR, "urls.txt");
const LOG_FILE = path.join(OUT_DIR, "istoric.log");
const PAGE_SIZE = 100;
/** Statusuri de documentatie aflate in validare — nu trimitem nimic peste ele. */
const BUSY_VALUES = new Set([1, 2, 3, 4, 11]);
const IMAGE_ERROR_RE = /IMAGE|DOWNLOAD|PHOTO|PICTURE|IMG/i;

function parseArgs(argv) {
  const args = { mode: argv[0] || "scan", netrimise: false, cooldownH: 6, produs: null, badUrls: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--netrimise") args.netrimise = true;
    else if (a === "--cooldown") args.cooldownH = Number(argv[++i]);
    else if (a === "--produs") args.produs = Number(argv[++i]);
    else if (a === "--url-uri-rele") args.badUrls = argv[++i];
  }
  if (!Number.isFinite(args.cooldownH) || args.cooldownH < 0) args.cooldownH = 6;
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function appendLog(line) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
}

async function postJson(base, auth, endpoint, data) {
  let last = "";
  for (let k = 0; k < 3; k++) {
    const r = await emagFetch(`${base}/${endpoint}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    const text = await r.text();
    try {
      return { status: r.status, json: JSON.parse(text) };
    } catch {
      last = `HTTP ${r.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`;
    }
    await sleep(2000);
  }
  throw new Error(last);
}

/** Toate ofertele de pe o platforma: Map offerId → oferta. */
async function readAllOffers(platform, creds) {
  const base = emagApiBase(platform);
  let auth = null;
  let first = null;
  for (const c of authCandidates(creds)) {
    auth = authHeader(c.user, c.pass);
    first = await postJson(base, auth, "product_offer/read", { currentPage: 1, itemsPerPage: PAGE_SIZE });
    if (first.status !== 401 && first.status !== 403) break;
  }
  const byId = new Map();
  let page = 1;
  let res = first;
  for (;;) {
    if (res.json.isError) {
      throw new Error(`${platform.toUpperCase()}: ${JSON.stringify(res.json.messages || []).slice(0, 200)}`);
    }
    const results = Array.isArray(res.json.results) ? res.json.results : [];
    for (const o of results) byId.set(String(o.id), o);
    if (results.length < PAGE_SIZE) break;
    page += 1;
    res = await postJson(base, auth, "product_offer/read", { currentPage: page, itemsPerPage: PAGE_SIZE });
  }
  return byId;
}

function validationOf(offer) {
  const v = (offer.validation_status || [])[0] || {};
  const errors = ((v.errors || {}).errors || v.errors || []);
  const codes = (Array.isArray(errors) ? errors : []).map((e) => String(e?.code || e?.message || e));
  return { value: Number(v.value), description: String(v.description || ""), codes };
}

function isBusy(val) {
  return BUSY_VALUES.has(val.value) || /pending|in progress|awaiting|waiting/i.test(val.description);
}

/** Ce e stricat la pozele unei oferte, fata de setul local. */
function imageIssues(offer, val, localCount) {
  const issues = [];
  const remote = Array.isArray(offer.images) ? offer.images : [];
  if (!remote.length) issues.push("fără poze pe eMAG");
  else if (remote.length < localCount) issues.push(`${remote.length}/${localCount} poze`);
  const codes = [...new Set(val.codes.filter((c) => IMAGE_ERROR_RE.test(c)))];
  if (codes.length) issues.push(codes.join(","));
  // Poze marcate individual ca esuate (orice camp in afara de url/display_type).
  const failed = remote.filter((img) =>
    Object.entries(img || {}).some(
      ([k, v]) => k !== "url" && k !== "display_type" && /fail|error|invalid|reject/i.test(String(v))
    )
  ).length;
  if (failed) issues.push(`${failed} poze cu eroare`);
  return issues;
}

async function scan(args) {
  if (!PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL lipsește — eMAG n-ar putea descărca pozele");
  const params = [];
  let where = "emag_offer_id IS NOT NULL AND TRIM(emag_offer_id) <> ''";
  if (args.produs) {
    params.push(args.produs);
    where += ` AND id = $1`;
  }
  const { rows: products } = await query(
    `SELECT id, cod_produs, emag_offer_id FROM catalog_products WHERE ${where} ORDER BY id`,
    params
  );
  const ids = products.map((p) => p.id);
  const imagesByProduct = await listByPlatformForProductIds(ids);
  const { rows: pushRows } = await query(
    `SELECT product_id, platform, fingerprint, pushed_at FROM product_images_push_state
     WHERE product_id = ANY($1::int[])`,
    [ids]
  );
  const pushState = new Map(pushRows.map((r) => [`${r.product_id}:${r.platform}`, r]));

  const creds = await loadCredentials();
  const offers = {};
  for (const platform of PLATFORMS) {
    process.stderr.write(`citesc ofertele eMAG ${platform.toUpperCase()}... `);
    offers[platform] = await readAllOffers(platform, creds);
    process.stderr.write(`${offers[platform].size}\n`);
  }

  const plan = [];
  const lines = [];
  const now = Date.now();
  for (const p of products) {
    const oid = String(p.emag_offer_id).trim();
    const label = `${String(p.id).padStart(3)} ${String(p.cod_produs || "").padEnd(18)}`;
    const byPlatform = imagesByProduct.get(Number(p.id));
    // Doar produsele cu seturi proprii pe RO, HU si BG — setul EN nu pleaca niciodata.
    if (!PLATFORMS.every((pl) => (byPlatform?.[pl] || []).length > 0)) continue;
    const perPlatform = [];
    let busy = null;
    for (const platform of PLATFORMS) {
      const offer = offers[platform].get(oid);
      if (!offer) continue;
      const val = validationOf(offer);
      if (isBusy(val)) busy = `${platform.toUpperCase()} în validare (${val.value})`;
      const eff = pickEffective(byPlatform, platform);
      if (!eff.images.length) continue;
      const stamp = imagesStamp(eff);
      const issues = imageIssues(offer, val, eff.images.length);
      const pushed = pushState.get(`${p.id}:${platform}`);
      if (args.netrimise && pushed?.fingerprint !== stamp) issues.push("poze noi netrimise");
      if (!issues.length) continue;
      if (!offer.ownership) {
        lines.push(`${label} ${platform.toUpperCase()}  SĂRIT: fără ownership (${issues.join("; ")})`);
        continue;
      }
      perPlatform.push({ platform, issues, eff, stamp });
    }
    if (!perPlatform.length) continue;
    const what = perPlatform.map((x) => `${x.platform.toUpperCase()}: ${x.issues.join("; ")}`).join(" | ");
    if (busy) {
      lines.push(`${label} AȘTEAPTĂ: ${busy} — ${what}`);
      continue;
    }
    const lastPush = Math.max(
      0,
      ...PLATFORMS.map((pl) => new Date(pushState.get(`${p.id}:${pl}`)?.pushed_at || 0).getTime())
    );
    const hoursAgo = (now - lastPush) / 3600000;
    if (hoursAgo < args.cooldownH) {
      lines.push(`${label} AȘTEAPTĂ: trimis acum ${hoursAgo.toFixed(1)}h (pauză ${args.cooldownH}h) — ${what}`);
      continue;
    }
    const next = perPlatform[0];
    plan.push({
      productId: p.id,
      sku: p.cod_produs,
      offerId: oid,
      platform: next.platform,
      issues: next.issues,
      stamp: next.stamp,
      source: next.eff.source,
      urls: next.eff.images.map((img) => absoluteUrl(img.stored_name)),
    });
    const later = perPlatform.slice(1).map((x) => x.platform.toUpperCase());
    lines.push(
      `${label} DE TRIMIS ${next.platform.toUpperCase()} (${next.eff.images.length} poze ${next.eff.source.toUpperCase()}): ${next.issues.join("; ")}` +
        (later.length ? `  [apoi ${later.join(", ")} la rulările următoare]` : "")
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(PLAN_FILE, JSON.stringify({ createdAt: new Date().toISOString(), plan }, null, 2));
  fs.writeFileSync(URLS_FILE, [...new Set(plan.flatMap((x) => x.urls))].join("\n") + (plan.length ? "\n" : ""));
  console.log(lines.length ? lines.join("\n") : "Nicio problemă de poze găsită.");
  console.log(`\n${products.length} produse verificate · ${plan.length} de trimis acum`);
}

async function push(args) {
  const { plan, createdAt } = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
  if (Date.now() - new Date(createdAt).getTime() > 30 * 60 * 1000) {
    throw new Error("plan.json e mai vechi de 30 de minute — rulează din nou scanarea");
  }
  // "-" = lista vine pe stdin (scriptul .sh o face pe PC, unde URL-urile chiar raspund).
  const badSource = args.badUrls === "-" ? 0 : args.badUrls;
  const bad = new Set(
    badSource === 0 || (badSource && fs.existsSync(badSource))
      ? fs.readFileSync(badSource, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)
      : []
  );
  const emag = getChannel("emag");
  let ok = 0;
  let failed = 0;
  for (const item of plan) {
    const label = `${item.productId} ${item.sku} ${item.platform.toUpperCase()}`;
    const broken = item.urls.filter((u) => bad.has(u));
    if (broken.length) {
      console.log(`${label}  SĂRIT: ${broken.length} URL-uri nu răspund de pe PC`);
      appendLog(`${label} SARIT url-uri rele ${broken.length}`);
      continue;
    }
    // Pozele s-au schimbat intre scanare si trimitere — nu trimitem un set neverificat.
    const eff = await effectiveImages(item.productId, item.platform);
    if (imagesStamp(eff) !== item.stamp) {
      console.log(`${label}  SĂRIT: pozele s-au schimbat după scanare`);
      continue;
    }
    try {
      const res = await emag.pushImages(item.platform, [{ offerId: item.offerId, images: item.urls }]);
      if (res.skipped?.length) throw new Error(res.skipped[0].error);
      await markImagesPushed(item.productId, item.platform, item.stamp);
      ok += 1;
      console.log(`${label}  TRIMIS ${item.urls.length} poze`);
      appendLog(`${label} TRIMIS ${item.urls.length} poze (${item.issues.join("; ")})`);
    } catch (err) {
      failed += 1;
      const msg = `${err.message}${err.messages ? " " + JSON.stringify(err.messages).slice(0, 300) : ""}`;
      console.log(`${label}  EROARE: ${msg}`);
      appendLog(`${label} EROARE ${msg}`);
    }
    await sleep(500);
  }
  console.log(`\n${ok} trimise · ${failed} erori · verifică din nou peste câteva ore (status 11 → 9)`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "push") await push(args);
  else await scan(args);
})()
  .catch((err) => {
    console.error(`EROARE: ${err.message || err}`);
    process.exitCode = 1;
  })
  .finally(() => endPool().catch(() => {}));
