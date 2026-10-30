/**
 * Retrimiterea pe eMAG din serviciul `validari`, când o țară a fost refuzată cu
 * UPDATE_NOT_ALLOWED_DIFFERENT_PLATFORM (altă țară era în validare) și acum nicio țară a produsului
 * nu mai e în validare. Ordinea RO → HU → BG, o singură țară odată pe produs.
 *
 * Ce pleacă e exact ce e în Base pentru țara aceea: titlul, descrierea și pozele (galeria implicită
 * pentru RO, galeria canalului `emaghu_206` / `emagbg_207` când are galerie proprie). Restul ofertei
 * (categorie, caracteristici, preț, stoc) rămâne cum e acum pe eMAG. Se trimite și când citirea eMAG arată
 * la fel ca Base: după un refuz, eMAG întoarce adesea textul refuzat, deși pe site a rămas cel vechi.
 *
 *   VALIDARI_SEND=1           trimite pe bune (altfel doar scrie „AR TRIMITE” în log)
 *   VALIDARI_RETRY_MIN=30     după cât timp poate retrimite aceeași variantă pe aceeași țară
 *   VALIDARI_MAX_TRIES=3      de câte ori trimite cel mult aceeași variantă pe aceeași țară
 */
const crypto = require("crypto");
const { query } = require("./pg");
const base = require("./base-client");
const { htmlToText } = require("./description-format");
const { emagFetch, emagApiBase, authHeader, authCandidates, loadCredentials } = require("./emag-client");

const PLATFORMS = ["ro", "hu", "bg"];
const LABEL = { ro: "RO", hu: "HU", bg: "BG" };
/** Canalul Base al fiecărei țări (getInventoryIntegrations). */
const CHANNEL = { ro: "emagro_149", hu: "emaghu_206", bg: "emagbg_207" };
/** Limba implicită a catalogului Base: textele ei stau în `name` / `description`, fără sufix. */
const DEFAULT_LANG = "ro";

const RETRY_MS = Math.max(5, Number(process.env.VALIDARI_RETRY_MIN || 30)) * 60_000;
const MAX_TRIES = Math.max(1, Number(process.env.VALIDARI_MAX_TRIES || 3));

function sendEnabled() {
  return process.env.VALIDARI_SEND === "1";
}

function plain(html) {
  return htmlToText(String(html || "")).replace(/\s+/g, " ").trim();
}

function imageId(url) {
  const m = String(url || "").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : String(url || "");
}

// ---------- ce e în Base ----------

/** Textul pentru țară: întâi valoarea doar pentru canal, apoi cea a limbii. */
function textFor(fields, field, platform) {
  const suffix = platform === DEFAULT_LANG ? "" : `|${platform}`;
  const keys = [`${field}|${platform}|${CHANNEL[platform]}`, `${field}${suffix}`];
  if (platform === DEFAULT_LANG) keys.splice(1, 0, `${field}|${platform}`);
  for (const k of keys) {
    const v = fields[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

/**
 * Galeria pe care o vede canalul țării, după media_options: 0 = galeria implicită,
 * 1 = galeria proprie a canalului, 2 = galeria implicită cu pozițiile canalului peste ea.
 */
function imagesFor(product, platform) {
  const channel = CHANNEL[platform];
  const all = product.images || {};
  const mode = Number((product.media_options || {})[channel] || 0);
  const byPos = new Map();
  const own = new Map();
  for (const [key, url] of Object.entries(all)) {
    const [pos, src] = key.split("|");
    if (!src) byPos.set(Number(pos), url);
    else if (src === channel) own.set(Number(pos), url);
  }
  let pick;
  if (mode === 1) pick = own;
  else if (mode === 2) pick = new Map([...byPos, ...own]);
  else pick = byPos;
  return [...pick.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, url]) => url)
    .filter((url) => url && String(url).trim());
}

function desiredFromBase(product, platform) {
  const fields = product.text_fields || {};
  return {
    name: textFor(fields, "name", platform),
    description: textFor(fields, "description", platform),
    images: imagesFor(product, platform),
  };
}

function differences(want, live) {
  const diff = [];
  if (want.name !== String(live.name || "").trim()) diff.push("titlu");
  if (plain(want.description) !== plain(live.description)) diff.push("descriere");
  const a = want.images.map(imageId).join("|");
  const b = (live.images || []).map((i) => imageId(i.url)).join("|");
  if (a !== b) diff.push(`poze ${(live.images || []).length} → ${want.images.length}`);
  return diff;
}

function fingerprint(want) {
  return crypto.createHash("sha1").update(JSON.stringify(want)).digest("hex");
}

// ---------- eMAG ----------

function buildPayload(live, want) {
  const payload = {
    id: live.id,
    category_id: live.category_id,
    name: want.name,
    part_number: live.part_number,
    brand: live.brand,
    description: want.description,
    characteristics: (live.characteristics || []).map((c) => ({ id: c.id, value: c.value })),
    ean: live.ean,
    sale_price: live.sale_price,
    min_sale_price: live.min_sale_price,
    max_sale_price: live.max_sale_price,
    vat_id: live.vat_id,
    status: live.status,
    stock: (live.stock || []).map((s) => ({ warehouse_id: Number(s.warehouse_id) || 1, value: s.value })),
    handling_time: (live.handling_time || []).map((h) => ({ warehouse_id: Number(h.warehouse_id) || 1, value: h.value })),
    images: want.images.map((url, i) => ({ display_type: i === 0 ? 1 : 2, url })),
    images_overwrite: 1,
  };
  if (live.recommended_price) payload.recommended_price = live.recommended_price;
  if (live.warranty != null) payload.warranty = live.warranty;
  if (live.family && live.family.id) {
    payload.family = { id: live.family.id, name: live.family.name, family_type_id: live.family.family_type_id };
  }
  return payload;
}

let credsPromise = null;
async function saveOffer(platform, payload) {
  credsPromise = credsPromise || loadCredentials();
  const creds = await credsPromise;
  let last;
  for (const c of authCandidates(creds)) {
    const res = await emagFetch(`${emagApiBase(platform)}/product_offer/save`, {
      method: "POST",
      headers: { Authorization: authHeader(c.user, c.pass), "Content-Type": "application/json" },
      body: JSON.stringify({ data: [payload] }),
      allowOfferSave: true,
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      last = new Error(`autentificare respinsă (${res.status})`);
      continue;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (json.isError) throw new Error(JSON.stringify(json.messages || []).slice(0, 300));
    return json;
  }
  throw last || new Error("fără credențiale");
}

// ---------- decizia ----------

/** Țara de retrimis acum: prima „blocat” în ordinea RO → HU → BG, dacă nicio țară nu e în validare. */
function candidatePlatforms(states) {
  if (PLATFORMS.some((p) => states[p] && states[p].grp === "validare")) return [];
  return PLATFORMS.filter((p) => states[p] && states[p].grp === "blocat");
}

async function recentTries(productId, platform, fp) {
  const { rows } = await query(
    `SELECT created_at FROM emag_validation_push
     WHERE product_id = $1 AND platform = $2 AND fingerprint = $3 AND sent
     ORDER BY created_at DESC`,
    [productId, platform, fp]
  );
  return { count: rows.length, last: rows[0] ? new Date(rows[0].created_at).getTime() : 0 };
}

async function record(productId, platform, fp, diff, sent, ok, message) {
  await query(
    `INSERT INTO emag_validation_push (product_id, platform, fingerprint, diff, sent, ok, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [productId, platform, fp, diff, sent, ok, message]
  );
}

/**
 * Retrimite din Base pe țările refuzate. `products`: [{ id, cod_produs, states: {ro,hu,bg}, live: {ro,hu,bg} }]
 * (live = oferta citită acum de pe eMAG). Întoarce mesajele de anunțat.
 */
async function pushBlocked(products, { log = console.log } = {}) {
  const work = products
    .map((p) => ({ ...p, platforms: candidatePlatforms(p.states) }))
    .filter((p) => p.platforms.length);
  if (!work.length) return [];

  const { rows: links } = await query(
    `SELECT product_id, base_product_id FROM base_products WHERE product_id = ANY($1) AND base_product_id IS NOT NULL`,
    [work.map((p) => p.id)]
  );
  const baseIdOf = new Map(links.map((r) => [Number(r.product_id), Number(r.base_product_id)]));
  const ids = [...new Set(work.map((p) => baseIdOf.get(p.id)).filter(Boolean))];
  const data = await base.call("getInventoryProductsData", {
    inventory_id: base.config().inventoryId,
    products: ids,
    include_channels_media: true,
  });
  const baseProducts = data.products || {};

  const messages = [];
  for (const p of work) {
    const who = `${p.id} ${p.cod_produs}`;
    const bp = baseProducts[String(baseIdOf.get(p.id))];
    if (!bp) {
      log(`${who}: nu e legat în Base, nu retrimit`);
      continue;
    }
    for (const platform of p.platforms) {
      const live = p.live[platform];
      if (!live) continue;
      const want = desiredFromBase(bp, platform);
      if (!want.name || !want.description || !want.images.length) {
        const lipsa = [!want.name && "titlul", !want.description && "descrierea", !want.images.length && "pozele"].filter(Boolean);
        log(`${who}: ${LABEL[platform]} nu are în Base ${lipsa.join(", ")} — nu retrimit`);
        continue;
      }
      // După un refuz, citirea eMAG arată de multe ori deja textul refuzat: nu ne putem baza pe ea,
      // deci trimitem ce e în Base oricum. Diferențele găsite apar doar în mesaj.
      const diff = differences(want, live);

      const fp = fingerprint(want);
      const tries = await recentTries(p.id, platform, fp);
      if (tries.count >= MAX_TRIES) {
        log(`${who}: ${LABEL[platform]} trimis deja de ${tries.count} ori la fel, nu mai retrimit`);
        break;
      }
      if (Date.now() - tries.last < RETRY_MS) break;

      const what = diff.length ? diff.join(", ") : "titlu, descriere, poze — eMAG arată deja la fel";
      if (!sendEnabled()) {
        log(`AR TRIMITE ${who} pe ${LABEL[platform]} din Base (${what}) — VALIDARI_SEND nu e 1`);
        break;
      }
      try {
        await saveOffer(platform, buildPayload(live, want));
        await record(p.id, platform, fp, what, true, true, null);
        messages.push(`📤 ${who}: retrimis pe ${LABEL[platform]} din Base (${what})`);
      } catch (e) {
        await record(p.id, platform, fp, what, true, false, e.message);
        messages.push(`⚠️ ${who}: retrimiterea pe ${LABEL[platform]} a picat — ${e.message}`);
      }
      // O singură țară odată: următoarea pleacă după ce asta iese din validare.
      break;
    }
  }
  return messages;
}

module.exports = { pushBlocked, desiredFromBase, differences, candidatePlatforms, sendEnabled };
