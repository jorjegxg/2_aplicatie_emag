/**
 * Coada de trimiteri eMAG amânate (tabela emag_push_queue).
 *
 * O intrare = „trimite pe platforma X a produsului P: pozele din aplicație și/sau titlul, descrierea,
 * caracteristicile”. Se trimite doar când:
 *   - a sosit `not_before`;
 *   - intrarea de care depinde (`after_id`) s-a validat (done/skipped);
 *   - nicio altă intrare a produsului nu e încă în validare (status `sent`);
 *   - nicio platformă a produsului nu e în validare pe eMAG (status 11). Excepție: `replace_pending`
 *     permite retrimiterea pe propria platformă, când actualizarea de acolo e blocată (ex. link-uri moarte);
 *   - ce e pe eMAG diferă de ce vrem sau ultima actualizare a platformei a fost respinsă.
 * Pe eMAG poate fi în validare o singură platformă a produsului; o actualizare trimisă cât timp alta
 * e în procesare e respinsă cu UPDATE_NOT_ALLOWED_DIFFERENT_PLATFORM, deși citirea arată textul nou.
 *
 * După trimitere (status `sent`) intrarea e „terminată” când platforma a trecut 11 -> 9 fără respingere,
 * sau a stat QUEUE_SETTLE_HOURS ore pe 9 fără erori. La respingere se reîncearcă după QUEUE_RETRY_MINUTES.
 */
const { query } = require("./pg");
const pi = require("./product-images");
const { htmlToText, textToHtml } = require("./description-format");
const {
  emagFetch,
  emagApiBase,
  loadCredentials,
  authHeader,
  authCandidates,
} = require("./emag-client");

const PLATFORMS = ["ro", "hu", "bg"];
const SETTLE_MS = Number(process.env.QUEUE_SETTLE_HOURS || 4) * 3600 * 1000;
const RETRY_MS = Number(process.env.QUEUE_RETRY_MINUTES || 30) * 60 * 1000;
const REJECTED = "UPDATE_NOT_ALLOWED_DIFFERENT_PLATFORM";
const IN_VALIDATION = 11;

const L1 = "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const NAMED = Object.fromEntries(L1.map((n, i) => [n, String.fromCharCode(192 + i)]));

/** Text comparabil: eMAG întoarce descrierea cu entități (&eacute;, &#337;) pe care htmlToText nu le știe pe toate. */
function plain(html) {
  return htmlToText(String(html || "").replace(/&([a-z]+);/gi, (m, n) => NAMED[n] ?? m))
    .replace(/\s+/g, " ")
    .trim();
}

function imageId(url) {
  const m = String(url || "").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : String(url || "");
}

function validation(offer) {
  const vs = (offer && offer.validation_status && offer.validation_status[0]) || {};
  const errs = ((vs.errors || {}).errors || []).map((e) => e.code).filter(Boolean);
  return { value: vs.value == null ? null : Number(vs.value), errors: [...new Set(errs)] };
}

// ---------- eMAG ----------

function createClient() {
  const auth = {};
  let credsPromise = null;

  async function call(platform, endpoint, data) {
    credsPromise = credsPromise || loadCredentials();
    const creds = await credsPromise;
    const tries = auth[platform] ? [auth[platform]] : authCandidates(creds);
    let last;
    for (const c of tries) {
      const res = await emagFetch(`${emagApiBase(platform)}/${endpoint}`, {
        method: "POST",
        headers: { Authorization: authHeader(c.user, c.pass), "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        last = new Error(`${endpoint} ${platform.toUpperCase()}: HTTP ${res.status} ${text.slice(0, 200)}`);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        last = new Error(`${endpoint} ${platform.toUpperCase()}: autentificare respinsă (${res.status})`);
        continue;
      }
      auth[platform] = c;
      return json;
    }
    throw last || new Error(`${endpoint} ${platform.toUpperCase()}: fără credențiale`);
  }

  async function readOffer(platform, offerId) {
    const json = await call(platform, "product_offer/read", { id: Number(offerId) });
    if (json.isError) {
      throw new Error(`read ${platform.toUpperCase()}: ${JSON.stringify(json.messages || []).slice(0, 200)}`);
    }
    return (json.results || [])[0] || null;
  }

  async function saveOffer(platform, payload) {
    return call(platform, "product_offer/save", [payload]);
  }

  return { readOffer, saveOffer };
}

// ---------- coada ----------

async function addItem(item) {
  const platform = String(item.platform || "").toLowerCase();
  if (!PLATFORMS.includes(platform)) throw new Error(`platformă invalidă: ${item.platform}`);
  if ((item.name_from_app || item.description_from_app) && platform !== "ro") {
    throw new Error("titlul/descrierea din aplicație există doar pentru RO; pe HU/BG dă textul explicit");
  }
  const { rows } = await query(
    `INSERT INTO emag_push_queue
       (product_id, platform, send_images, name, description, name_from_app, description_from_app,
        characteristics, not_before, after_id, replace_pending, max_attempts, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()),$10,$11,$12,$13)
     RETURNING *`,
    [
      Number(item.product_id),
      platform,
      item.send_images !== false,
      item.name ?? null,
      item.description ?? null,
      Boolean(item.name_from_app),
      Boolean(item.description_from_app),
      item.characteristics ? JSON.stringify(item.characteristics) : null,
      item.not_before || null,
      item.after_id ? Number(item.after_id) : null,
      Boolean(item.replace_pending),
      Number(item.max_attempts || 3),
      item.note ?? null,
    ]
  );
  return rows[0];
}

async function listItems({ all = false } = {}) {
  const { rows } = await query(
    `SELECT q.*, c.cod_produs FROM emag_push_queue q JOIN catalog_products c ON c.id = q.product_id
     ${all ? "" : "WHERE q.status IN ('pending','sent') OR q.updated_at > now() - interval '1 day'"}
     ORDER BY q.id`
  );
  return rows;
}

async function setStatus(id, status, message) {
  await query(
    `UPDATE emag_push_queue SET status=$2, last_message=COALESCE($3,last_message), updated_at=now(),
       done_at = CASE WHEN $2 IN ('done','skipped','failed','cancelled') THEN now() ELSE done_at END
     WHERE id=$1`,
    [id, status, message ?? null]
  );
}

async function cancelItem(id) {
  await setStatus(Number(id), "cancelled", "anulat manual");
}

async function retryItem(id) {
  await query(
    `UPDATE emag_push_queue SET status='pending', attempts=0, not_before=now(), seen_pending=false,
       last_message='repus în coadă manual', updated_at=now(), done_at=NULL WHERE id=$1`,
    [Number(id)]
  );
}

// ---------- ce vrem pe eMAG ----------

async function desiredFor(item, product, live) {
  const want = {};
  if (item.send_images) {
    const eff = await pi.effectiveImages(item.product_id, item.platform);
    want.images = eff.images.map((img) => pi.absoluteUrl(img.stored_name));
    want.fingerprint = pi.imagesFingerprint(eff.images);
    if (!want.images.length) throw new Error("produsul nu are poze în aplicație pentru platforma asta");
  }
  if (item.name_from_app) want.name = String(product.nume || "").trim();
  else if (item.name) want.name = String(item.name).trim();
  if (item.description_from_app) want.description = textToHtml(String(product.descriere || "").trim());
  else if (item.description) want.description = textToHtml(String(item.description).trim());
  if (item.characteristics) {
    const changes = item.characteristics;
    const replaced = new Set(Object.keys(changes).map(String));
    want.characteristics = (live.characteristics || [])
      .filter((c) => !replaced.has(String(c.id)))
      .map((c) => ({ id: c.id, value: c.value }))
      .concat(
        Object.entries(changes).flatMap(([id, v]) => [].concat(v).map((value) => ({ id: Number(id), value: String(value) })))
      );
  }
  return want;
}

function differences(want, live) {
  const diff = [];
  if (want.images) {
    const a = want.images.map(imageId).join("|");
    const b = (live.images || []).map((i) => imageId(i.url)).join("|");
    if (a !== b) diff.push(`poze ${(live.images || []).length} -> ${want.images.length}`);
  }
  if (want.name != null && want.name !== String(live.name || "").trim()) diff.push("titlu");
  if (want.description != null && plain(want.description) !== plain(live.description)) diff.push("descriere");
  if (want.characteristics) {
    const key = (list) => list.map((c) => `${c.id}=${c.value}`).sort().join("|");
    if (key(want.characteristics) !== key(live.characteristics || [])) diff.push("caracteristici");
  }
  return diff;
}

function buildPayload(live, want) {
  const payload = {
    id: live.id,
    category_id: live.category_id,
    name: want.name ?? live.name,
    part_number: live.part_number,
    brand: live.brand,
    description: want.description ?? live.description,
    characteristics: want.characteristics || (live.characteristics || []).map((c) => ({ id: c.id, value: c.value })),
    ean: live.ean,
    sale_price: live.sale_price,
    min_sale_price: live.min_sale_price,
    max_sale_price: live.max_sale_price,
    vat_id: live.vat_id,
    status: live.status,
    stock: (live.stock || []).map((s) => ({ warehouse_id: Number(s.warehouse_id) || 1, value: s.value })),
    handling_time: (live.handling_time || []).map((h) => ({ warehouse_id: Number(h.warehouse_id) || 1, value: h.value })),
  };
  if (want.images) {
    payload.images = want.images.map((url, i) => ({ display_type: i === 0 ? 1 : 2, url }));
    payload.images_overwrite = 1;
  } else if (Array.isArray(live.images)) {
    payload.images = live.images.map((i) => ({ display_type: i.display_type, url: i.url }));
  }
  if (live.recommended_price) payload.recommended_price = live.recommended_price;
  if (live.warranty != null) payload.warranty = live.warranty;
  if (live.family && live.family.id) {
    payload.family = { id: live.family.id, name: live.family.name, family_type_id: live.family.family_type_id };
  }
  return payload;
}

// ---------- o trecere ----------

/**
 * @param {{send?: boolean, log?: (s: string) => void}} opts  send=false: doar arată ce ar trimite
 */
async function processOnce({ send = false, log = console.log } = {}) {
  const items = (
    await query(
      `SELECT q.*, c.cod_produs, c.emag_offer_id, c.nume, c.descriere
       FROM emag_push_queue q JOIN catalog_products c ON c.id = q.product_id
       WHERE q.status IN ('pending','sent') ORDER BY q.id`
    )
  ).rows;
  if (!items.length) return { open: 0 };

  const client = createClient();
  const offers = new Map(); // `${pid}:${pl}` -> oferta
  async function offer(pid, offerId, pl, fresh = false) {
    const k = `${pid}:${pl}`;
    if (fresh || !offers.has(k)) offers.set(k, await client.readOffer(pl, offerId));
    return offers.get(k);
  }
  const byId = new Map(
    (await query(`SELECT id, status FROM emag_push_queue WHERE id = ANY($1)`, [items.map((i) => i.after_id).filter(Boolean)])).rows.map((r) => [r.id, r.status])
  );
  const now = Date.now();
  const tag = (it) => `#${it.id} [${it.product_id} ${it.cod_produs} ${it.platform.toUpperCase()}]`;
  const touch = (id, msg) =>
    query(`UPDATE emag_push_queue SET last_check_at=now(), last_message=COALESCE($2,last_message), updated_at=now() WHERE id=$1`, [id, msg ?? null]);

  // 1) intrările trimise: au terminat validarea?
  for (const it of items.filter((i) => i.status === "sent")) {
    try {
      const live = await offer(it.product_id, it.emag_offer_id, it.platform);
      const v = validation(live);
      if (v.value === IN_VALIDATION) {
        if (!it.seen_pending) await query(`UPDATE emag_push_queue SET seen_pending=true WHERE id=$1`, [it.id]);
        await touch(it.id, "în validare pe eMAG (11)");
        continue;
      }
      const age = now - new Date(it.sent_at).getTime();
      const rejected = v.errors.includes(REJECTED);
      if (rejected && (it.seen_pending || age >= SETTLE_MS)) {
        if (it.attempts < it.max_attempts) {
          await query(
            `UPDATE emag_push_queue SET status='pending', seen_pending=false, not_before=$2, updated_at=now(),
               last_message=$3 WHERE id=$1`,
            [it.id, new Date(now + RETRY_MS), `respins (${REJECTED}); reîncerc după ${RETRY_MS / 60000} min`]
          );
          log(`${tag(it)} RESPINS de eMAG; reîncerc după ${RETRY_MS / 60000} min`);
        } else {
          await setStatus(it.id, "failed", `respins de ${it.attempts} ori (${REJECTED})`);
          log(`${tag(it)} EȘUAT: respins de ${it.attempts} ori`);
        }
      } else if (v.value === 9 && (it.seen_pending || age >= SETTLE_MS) && !v.errors.length) {
        await setStatus(it.id, "done", it.seen_pending ? "validat (11 -> 9)" : `validat (${SETTLE_MS / 3600000} ore pe 9, fără erori)`);
        log(`${tag(it)} VALIDAT`);
      } else if (v.value === 9 && (it.seen_pending || age >= SETTLE_MS) && v.errors.length) {
        await setStatus(it.id, "failed", `validare terminată cu erori: ${v.errors.join(",")}`);
        log(`${tag(it)} EȘUAT: ${v.errors.join(",")}`);
      } else {
        await touch(it.id, `aștept validarea (status ${v.value}${v.errors.length ? ", " + v.errors.join(",") : ""})`);
      }
    } catch (e) {
      await touch(it.id, `eroare la citire: ${e.message}`);
      log(`${tag(it)} eroare la citire: ${e.message}`);
    }
  }

  // 2) intrările care așteaptă: se pot trimite acum?
  const fresh = (
    await query(`SELECT id, product_id, status FROM emag_push_queue WHERE status IN ('pending','sent')`)
  ).rows;
  const busyProducts = new Set(fresh.filter((r) => r.status === "sent").map((r) => r.product_id));
  for (const it of items.filter((i) => i.status === "pending")) {
    if (!fresh.find((r) => r.id === it.id && r.status === "pending")) continue; // tocmai repusă / schimbată
    if (new Date(it.not_before).getTime() > now) continue;
    if (it.after_id) {
      const dep = byId.get(it.after_id);
      const depNow = (await query(`SELECT status FROM emag_push_queue WHERE id=$1`, [it.after_id])).rows[0]?.status || dep;
      if (depNow === "failed" || depNow === "cancelled") {
        await setStatus(it.id, "failed", `depinde de #${it.after_id}, care e ${depNow}`);
        log(`${tag(it)} EȘUAT: depinde de #${it.after_id} (${depNow})`);
        continue;
      }
      if (depNow !== "done" && depNow !== "skipped") {
        await touch(it.id, `aștept #${it.after_id} (${depNow})`);
        continue;
      }
    }
    if (busyProducts.has(it.product_id)) {
      await touch(it.id, "aștept: altă trimitere a produsului e în validare");
      continue;
    }
    try {
      const state = {};
      for (const pl of PLATFORMS) {
        const o = await offer(it.product_id, it.emag_offer_id, pl);
        state[pl] = o ? validation(o) : null;
      }
      const live = await offer(it.product_id, it.emag_offer_id, it.platform);
      if (!live) {
        await setStatus(it.id, "failed", `oferta nu există pe eMAG ${it.platform.toUpperCase()}`);
        log(`${tag(it)} EȘUAT: oferta nu există`);
        continue;
      }
      if (live.ownership === false) {
        await setStatus(it.id, "failed", "fără ownership pe documentație");
        log(`${tag(it)} EȘUAT: fără ownership`);
        continue;
      }
      const busy = PLATFORMS.filter(
        (pl) => state[pl] && state[pl].value === IN_VALIDATION && !(pl === it.platform && it.replace_pending)
      );
      if (busy.length) {
        await touch(it.id, `aștept: ${busy.map((p) => p.toUpperCase()).join(", ")} în validare (11)`);
        continue;
      }
      const want = await desiredFor(it, it, live);
      const diff = differences(want, live);
      const own = state[it.platform];
      const lastRejected = own.errors.includes(REJECTED) || own.errors.includes("DOWNLOAD_FAILED");
      const stuck = it.replace_pending && own.value === IN_VALIDATION;
      if (!diff.length && !lastRejected && !stuck) {
        await setStatus(it.id, "skipped", "pe eMAG e deja la fel; nimic de trimis");
        log(`${tag(it)} SĂRIT: deja la zi`);
        continue;
      }
      const why = [...diff, lastRejected ? `ultima actualizare respinsă (${own.errors.join(",")})` : null, stuck ? "blocat în 11" : null]
        .filter(Boolean)
        .join("; ");
      if (!send) {
        log(`${tag(it)} AR TRIMITE: ${why}`);
        await touch(it.id, `gata de trimis (QUEUE_SEND=0): ${why}`);
        continue;
      }
      const res = await client.saveOffer(it.platform, buildPayload(live, want));
      const attempts = it.attempts + 1;
      if (res.isError) {
        const msg = `eMAG a refuzat salvarea: ${JSON.stringify(res.messages || []).slice(0, 300)}`;
        if (attempts < it.max_attempts) {
          await query(
            `UPDATE emag_push_queue SET attempts=$2, not_before=$3, last_message=$4, updated_at=now() WHERE id=$1`,
            [it.id, attempts, new Date(now + RETRY_MS), msg]
          );
        } else {
          await query(`UPDATE emag_push_queue SET attempts=$2 WHERE id=$1`, [it.id, attempts]);
          await setStatus(it.id, "failed", msg);
        }
        log(`${tag(it)} REFUZAT: ${msg}`);
        continue;
      }
      if (want.fingerprint) await pi.markImagesPushed(it.product_id, it.platform, want.fingerprint);
      await query(
        `UPDATE emag_push_queue SET status='sent', attempts=$2, sent_at=now(), seen_pending=false,
           last_message=$3, updated_at=now() WHERE id=$1`,
        [it.id, attempts, `trimis: ${why}`]
      );
      busyProducts.add(it.product_id);
      offers.delete(`${it.product_id}:${it.platform}`);
      log(`${tag(it)} TRIMIS: ${why}`);
    } catch (e) {
      await touch(it.id, `eroare: ${e.message}`);
      log(`${tag(it)} eroare: ${e.message}`);
    }
  }
  return { open: items.length };
}

module.exports = {
  addItem,
  listItems,
  cancelItem,
  retryItem,
  processOnce,
  differences,
  plain,
  imageId,
};
