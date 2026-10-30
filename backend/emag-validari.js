/**
 * Urmărirea validărilor eMAG pe RO/HU/BG. Doar citește (product_offer/read), nu trimite nimic pe eMAG.
 *
 * La fiecare verificare citește toate ofertele de pe cele trei platforme, le leagă de produse după
 * part_number = cod_produs și salvează statusul de validare în emag_validation_state.
 * Când o platformă iese din validare, spune pe ce platformă poți pune produsul acum (ordinea RO → HU → BG,
 * RO are întâietate) și trimite mesaj pe Telegram, dacă TELEGRAM_BOT_TOKEN și TELEGRAM_CHAT_ID sunt puse.
 * Țările refuzate cât era alta în validare sunt retrimise din Base de validari-push.js (VALIDARI_SEND=1).
 */
const { query, withClient } = require("./pg");
const { emagFetch, emagApiBase, authHeader, authCandidates, loadCredentials, ITEMS_PER_PAGE } = require("./emag-client");
const { pushBlocked } = require("./validari-push");

const PLATFORMS = ["ro", "hu", "bg"];
const LABEL = { ro: "RO", hu: "HU", bg: "BG" };
const LOCK_KEY = 728028; // pg_advisory_lock: o singură verificare odată (serviciul + butonul din pagină)
const MAX_PAGES = 50;

// validation_status de pe eMAG: 1–4 documentație nouă în validare, 11 actualizare în validare,
// 9 aprobat, 5/6/8/10/12 respins sau blocat.
const IN_VALIDATION = new Set([1, 2, 3, 4, 11]);
const REJECTED = new Set([5, 6, 8, 10, 12]);
// Actualizarea refuzată pentru că altă țară era în validare: conținutul e bun, doar trebuie retrimis.
const OTHER_PLATFORM_BUSY = "UPDATE_NOT_ALLOWED_DIFFERENT_PLATFORM";

const GROUP_TEXT = {
  validare: "în validare",
  validat: "validat",
  blocat: "refuzat (altă țară în validare)",
  respins: "respins",
  altul: "alt status",
  lipsa: "lipsă",
};

function validation(offer) {
  const vs = (offer && offer.validation_status && offer.validation_status[0]) || {};
  const errs = ((vs.errors || {}).errors || [])
    .map((e) => e.code || (e.message && (e.message.ro_RO || e.message.en_GB)) || "")
    .map((s) => String(s).slice(0, 120))
    .filter(Boolean);
  return {
    value: vs.value == null ? null : Number(vs.value),
    text: vs.description || null,
    errors: [...new Set(errs)],
  };
}

function groupOf(v) {
  if (IN_VALIDATION.has(v.value)) return "validare";
  if (REJECTED.has(v.value)) return "respins";
  // 9 cu erori: ultima actualizare a fost respinsă (de ex. UPDATE_NOT_ALLOWED), rămâne documentația veche.
  if (v.value === 9) {
    if (!v.errors.length) return "validat";
    return v.errors.every((e) => e === OTHER_PLATFORM_BUSY) ? "blocat" : "respins";
  }
  return "altul";
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
        last = new Error(`${endpoint} ${LABEL[platform]}: HTTP ${res.status} ${text.slice(0, 200)}`);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        last = new Error(`${endpoint} ${LABEL[platform]}: autentificare respinsă (${res.status})`);
        continue;
      }
      auth[platform] = c;
      return json;
    }
    throw last || new Error(`${endpoint} ${LABEL[platform]}: fără credențiale`);
  }

  async function readAllOffers(platform) {
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const json = await call(platform, "product_offer/read", { currentPage: page, itemsPerPage: ITEMS_PER_PAGE });
      if (json.isError) {
        const msg = (json.messages || []).map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("; ");
        throw new Error(`eMAG ${LABEL[platform]}: ${msg.slice(0, 200) || "eroare"}`);
      }
      const rows = json.results || [];
      all.push(...rows);
      if (rows.length < ITEMS_PER_PAGE) break;
    }
    return all;
  }

  return { readAllOffers };
}

// ---------- pasul următor ----------

/**
 * Ce ai de făcut acum cu produsul, cu RO întâi. `states` = { ro: {grp, ...} | undefined, ... },
 * `next` = platforma deblocată de ultima validare (din emag_validation_next) sau null.
 */
function nextStep(states, next) {
  for (const p of PLATFORMS) {
    const s = states[p];
    const grp = s ? s.grp : "lipsa";
    if (grp === "validare") return { action: "asteapta", platform: p, text: `Așteaptă ${LABEL[p]} (în validare)` };
    if (grp === "respins") return { action: "repara", platform: p, text: `Repară ${LABEL[p]} (respins)` };
    if (grp === "blocat") {
      const busy = PLATFORMS.filter((o) => o !== p && states[o] && states[o].grp === "validare");
      if (busy.length) {
        const who = busy.map((o) => LABEL[o]).join(", ");
        return { action: "asteapta", platform: busy[0], text: `Așteaptă ${who}, apoi retrimite pe ${LABEL[p]}` };
      }
      return { action: "pune", platform: p, text: `Retrimite pe ${LABEL[p]} (refuzat cât era altă țară în validare)` };
    }
    if (grp === "lipsa") return { action: "pune", platform: p, text: `Pune pe ${LABEL[p]}` };
    if (grp === "altul") return { action: "verifica", platform: p, text: `Verifică ${LABEL[p]} (status ${s.status})` };
    if (p === next) {
      const prev = PLATFORMS[PLATFORMS.indexOf(p) - 1];
      return { action: "pune", platform: p, text: `Pune pe ${LABEL[p]} (${LABEL[prev]} validat)` };
    }
  }
  return { action: "gata", platform: null, text: "—" };
}

// ---------- Telegram ----------

function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function notifyTelegram(text) {
  if (!telegramConfigured()) return false;
  // Telegram acceptă cel mult 4096 de caractere pe mesaj.
  const chunks = [];
  let cur = "";
  for (const line of String(text).split("\n")) {
    if (cur && cur.length + line.length + 1 > 4000) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: chunk, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`Telegram: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return true;
}

// ---------- verificarea ----------

function statusLabel(v) {
  return v == null ? "—" : String(v);
}

/** Mesajul pentru o tranziție sau null dacă nu e de anunțat (intrarea în validare o faci chiar tu). */
function transitionMessage(product, platform, prev, cur, states, next) {
  const who = `${product.id} ${product.cod_produs}`;
  const arrow = `${statusLabel(prev && prev.status)} → ${statusLabel(cur.status)}`;
  if (cur.grp === "blocat" && (!prev || prev.grp !== "blocat")) {
    return `⛔ ${who}: ${LABEL[platform]} refuzat, altă țară era în validare (${arrow}) — ${nextStep(states, next).text}`;
  }
  if (cur.grp === "respins" && (!prev || prev.grp !== "respins")) {
    const why = cur.errors.length ? `, ${cur.errors.join(", ")}` : "";
    return `❌ ${who}: ${LABEL[platform]} respins (${arrow}${why}) — repară ${LABEL[platform]}`;
  }
  if (cur.grp === "validat" && prev && prev.grp === "validare") {
    const step = nextStep(states, next);
    const tail = step.action === "gata" ? "gata pe toate platformele" : step.text;
    return `✅ ${who}: ${LABEL[platform]} validat (${arrow}) — ${tail}`;
  }
  return null;
}

async function setMeta(key, value) {
  await query(
    `INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}

/**
 * O verificare completă. Întoarce { skipped } dacă rulează deja alta, altfel
 * { platforms: { ro: { ok, offers, error } }, events: [...], notified }.
 */
async function processOnce({ log = console.log, notify = true } = {}) {
  return withClient(async (lockClient) => {
    const { rows: lock } = await lockClient.query(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY]);
    if (!lock[0].ok) return { skipped: true };
    try {
      return await runCheck({ log, notify });
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
    }
  });
}

async function runCheck({ log, notify }) {
  const client = createClient();
  const { rows: products } = await query(`SELECT id, cod_produs FROM catalog_products WHERE cod_produs IS NOT NULL`);
  const bySku = new Map(products.map((p) => [String(p.cod_produs).trim().toUpperCase(), p]));
  const productById = new Map(products.map((p) => [p.id, p]));

  const { rows: oldRows } = await query(`SELECT * FROM emag_validation_state`);
  const old = new Map(oldRows.map((r) => [`${r.product_id}|${r.platform}`, r]));
  const { rows: nextRows } = await query(`SELECT product_id, platform FROM emag_validation_next`);
  const nextBy = new Map(nextRows.map((r) => [r.product_id, r.platform]));

  const result = { platforms: {}, events: [], notified: false };
  const fresh = new Map(); // product_id|platform -> stare nouă, doar pentru platformele citite cu succes
  const liveBy = new Map(); // product_id|platform -> oferta de pe eMAG, pentru retrimitere

  for (const platform of PLATFORMS) {
    try {
      const offers = await client.readAllOffers(platform);
      // La același cod pot fi mai multe oferte (de ex. una veche invalidă): o păstrăm pe cea mai nouă.
      const best = new Map();
      for (const o of offers) {
        const p = bySku.get(String(o.part_number || "").trim().toUpperCase());
        if (!p) continue;
        const prev = best.get(p.id);
        if (!prev || Number(o.id) > Number(prev.id)) best.set(p.id, o);
      }
      for (const [productId, o] of best) {
        const v = validation(o);
        liveBy.set(`${productId}|${platform}`, o);
        fresh.set(`${productId}|${platform}`, {
          product_id: productId,
          platform,
          offer_id: Number(o.id),
          status: v.value,
          status_text: v.text,
          errors: v.errors,
          grp: groupOf(v),
        });
      }
      result.platforms[platform] = { ok: true, offers: offers.length, matched: best.size };
    } catch (e) {
      result.platforms[platform] = { ok: false, error: e.message };
      log(`${LABEL[platform]}: nu am putut citi ofertele — ${e.message}`);
    }
  }

  const okPlatforms = PLATFORMS.filter((p) => result.platforms[p].ok);
  // Prima citire a unei platforme doar salvează starea, ca să nu vină zeci de mesaje deodată.
  const seeded = new Set(okPlatforms.filter((p) => !oldRows.some((r) => r.platform === p)));

  // Starea curentă pe produs (nouă unde am citit, veche unde citirea a picat), pentru pasul următor.
  const statesOf = (productId) => {
    const out = {};
    for (const p of PLATFORMS) {
      const key = `${productId}|${p}`;
      const s = result.platforms[p].ok ? fresh.get(key) : old.get(key);
      if (s) out[p] = s;
    }
    return out;
  };

  const messages = [];
  for (const [key, cur] of fresh) {
    const prev = old.get(key);
    const changed = !prev || prev.status !== cur.status || JSON.stringify(prev.errors || []) !== JSON.stringify(cur.errors);
    const groupChanged = !prev || prev.grp !== cur.grp;

    await query(
      `INSERT INTO emag_validation_state (product_id, platform, offer_id, status, status_text, errors, grp, since, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
       ON CONFLICT (product_id, platform) DO UPDATE SET
         offer_id = EXCLUDED.offer_id, status = EXCLUDED.status, status_text = EXCLUDED.status_text,
         errors = EXCLUDED.errors, grp = EXCLUDED.grp, checked_at = now(),
         since = CASE WHEN emag_validation_state.status IS DISTINCT FROM EXCLUDED.status
                        OR emag_validation_state.errors <> EXCLUDED.errors
                      THEN now() ELSE emag_validation_state.since END`,
      [cur.product_id, cur.platform, cur.offer_id, cur.status, cur.status_text, JSON.stringify(cur.errors), cur.grp]
    );
    if (!changed || seeded.has(cur.platform)) continue;

    // Platforma deblocată: după validarea RO poți pune pe HU, după HU pe BG.
    if (cur.grp === "validare" && nextBy.get(cur.product_id) === cur.platform) {
      await query(`DELETE FROM emag_validation_next WHERE product_id = $1`, [cur.product_id]);
      nextBy.delete(cur.product_id);
    }
    if (cur.grp === "validat" && prev && prev.grp === "validare") {
      const after = PLATFORMS[PLATFORMS.indexOf(cur.platform) + 1];
      if (after) {
        await query(
          `INSERT INTO emag_validation_next (product_id, platform) VALUES ($1, $2)
           ON CONFLICT (product_id) DO UPDATE SET platform = EXCLUDED.platform, created_at = now()`,
          [cur.product_id, after]
        );
        nextBy.set(cur.product_id, after);
      } else {
        await query(`DELETE FROM emag_validation_next WHERE product_id = $1`, [cur.product_id]);
        nextBy.delete(cur.product_id);
      }
    }

    if (!groupChanged) continue;
    const product = productById.get(cur.product_id);
    const message = transitionMessage(product, cur.platform, prev, cur, statesOf(cur.product_id), nextBy.get(cur.product_id) || null);
    const { rows } = await query(
      `INSERT INTO emag_validation_events (product_id, platform, from_status, to_status, from_grp, to_grp, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [cur.product_id, cur.platform, prev ? prev.status : null, cur.status, prev ? prev.grp : null, cur.grp, message]
    );
    result.events.push({ id: rows[0].id, product: product.cod_produs, platform: cur.platform, from: prev && prev.status, to: cur.status, message });
    if (message) messages.push({ id: rows[0].id, message });
  }

  // Oferte care nu mai apar pe o platformă citită cu succes: produsul devine „lipsă” acolo.
  for (const [key, prev] of old) {
    if (!result.platforms[prev.platform].ok || fresh.has(key)) continue;
    await query(`DELETE FROM emag_validation_state WHERE product_id = $1 AND platform = $2`, [prev.product_id, prev.platform]);
  }

  // Retrimiterea din Base, doar când toate țările s-au citit (altfel nu știm sigur că nimic nu e în validare).
  if (okPlatforms.length === PLATFORMS.length) {
    const blocked = [...new Set([...fresh.values()].filter((s) => s.grp === "blocat").map((s) => s.product_id))];
    const list = blocked.map((id) => ({
      id,
      cod_produs: productById.get(id).cod_produs,
      states: statesOf(id),
      live: Object.fromEntries(PLATFORMS.map((p) => [p, liveBy.get(`${id}|${p}`)])),
    }));
    try {
      const pushed = await pushBlocked(list, { log });
      messages.push(...pushed.map((message) => ({ id: null, message })));
      result.pushed = pushed;
    } catch (e) {
      log(`retrimiterea din Base: ${e.message}`);
    }
  }

  for (const m of messages) log(m.message);
  if (notify && messages.length) {
    try {
      if (await notifyTelegram(messages.map((m) => m.message).join("\n"))) {
        const ids = messages.map((m) => m.id).filter((id) => id != null);
        await query(`UPDATE emag_validation_events SET notified = true WHERE id = ANY($1)`, [ids]);
        result.notified = true;
      }
    } catch (e) {
      log(`Telegram: ${e.message}`);
    }
  }

  await setMeta("validari_last_run", { at: new Date().toISOString(), platforms: result.platforms });
  return result;
}

// ---------- pagina Validări ----------

async function getOverview() {
  const { rows: states } = await query(`SELECT * FROM emag_validation_state`);
  const { rows: nextRows } = await query(`SELECT product_id, platform FROM emag_validation_next`);
  const nextBy = new Map(nextRows.map((r) => [r.product_id, r.platform]));
  const ids = [...new Set(states.map((s) => s.product_id))];
  const { rows: products } = await query(
    `SELECT id, cod_produs, nume, part_number_key FROM catalog_products WHERE id = ANY($1) ORDER BY id`,
    [ids]
  );
  const byProduct = new Map();
  for (const s of states) {
    if (!byProduct.has(s.product_id)) byProduct.set(s.product_id, {});
    byProduct.get(s.product_id)[s.platform] = {
      offer_id: Number(s.offer_id),
      status: s.status,
      status_text: s.status_text,
      errors: s.errors || [],
      grp: s.grp,
      grp_text: GROUP_TEXT[s.grp],
      since: s.since,
    };
  }
  const items = products.map((p) => {
    const st = byProduct.get(p.id) || {};
    return { id: p.id, cod_produs: p.cod_produs, nume: p.nume, pnk: p.part_number_key || null, platforms: st, next: nextStep(st, nextBy.get(p.id) || null) };
  });
  const { rows: events } = await query(
    `SELECT e.*, c.cod_produs FROM emag_validation_events e
     LEFT JOIN catalog_products c ON c.id = e.product_id
     ORDER BY e.created_at DESC, e.id DESC LIMIT 100`
  );
  const { rows: meta } = await query(`SELECT value FROM app_meta WHERE key = 'validari_last_run'`);
  let lastRun = null;
  try {
    lastRun = meta[0] ? JSON.parse(meta[0].value) : null;
  } catch {
    lastRun = null;
  }
  return { items, events, lastRun, telegram: telegramConfigured() };
}

module.exports = { PLATFORMS, LABEL, createClient, processOnce, getOverview, nextStep, notifyTelegram, telegramConfigured, validation, groupOf };
