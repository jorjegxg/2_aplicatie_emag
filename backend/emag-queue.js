/**
 * Coada de trimiteri amânate (tabela emag_push_queue). Din 2026-10-26 trimiterea merge în Base,
 * nu direct pe eMAG: o intrare = „trimite produsul P în Base” (cu textele platformei lui).
 * Textele HU/BG dintr-o intrare nouă se salvează imediat în product_texts, ca să se vadă în
 * pagina „Pregătire Base”. Se trimite doar când:
 *   - a sosit `not_before`;
 *   - intrarea de care depinde (`after_id`) e terminată (done/skipped/sent — `sent` = trimis
 *     direct pe eMAG înainte de Base, a cărui validare nu se mai urmărește);
 *   - produsul nu a fost deja trimis în aceeași trecere.
 * Fără BASE_SEND=1 doar notează ce ar trimite (vezi base-client.js).
 */
const { query } = require("./pg");
const { saveTexts, getTexts, pushProductToBase, buildPayload } = require("./base-push");

const PLATFORMS = ["ro", "hu", "bg"];
const RETRY_MS = Number(process.env.QUEUE_RETRY_MINUTES || 30) * 60 * 1000;

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
  const row = rows[0];
  if (platform !== "ro" && (item.name || item.description)) {
    const current = (await getTexts(row.product_id))[platform];
    await saveTexts(row.product_id, platform, {
      name: item.name ?? current.name,
      description: item.description ?? current.description,
      characteristics: current.characteristics,
    });
  }
  return row;
}

async function listItems({ all = false } = {}) {
  const { rows } = await query(
    `SELECT q.*, c.cod_produs, c.nume FROM emag_push_queue q JOIN catalog_products c ON c.id = q.product_id
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

// ---------- o trecere ----------

/**
 * @param {{send?: boolean, log?: (s: string) => void}} opts  send=false: doar arată ce ar trimite
 */
async function processOnce({ send = false, log = console.log } = {}) {
  const items = (
    await query(
      `SELECT q.*, c.cod_produs FROM emag_push_queue q JOIN catalog_products c ON c.id = q.product_id
       WHERE q.status = 'pending' ORDER BY q.id`
    )
  ).rows;
  if (!items.length) return { open: 0 };

  const now = Date.now();
  const tag = (it) => `#${it.id} [${it.product_id} ${it.cod_produs} ${it.platform.toUpperCase()}]`;
  const touch = (id, msg) =>
    query(`UPDATE emag_push_queue SET last_check_at=now(), last_message=COALESCE($2,last_message), updated_at=now() WHERE id=$1`, [id, msg ?? null]);
  const pushed = new Map(); // product_id -> mesajul trimiterii din trecerea asta

  for (const it of items) {
    if (new Date(it.not_before).getTime() > now) continue;
    if (it.after_id) {
      const dep = (await query(`SELECT status FROM emag_push_queue WHERE id=$1`, [it.after_id])).rows[0]?.status;
      if (dep === "failed" || dep === "cancelled") {
        await setStatus(it.id, "failed", `depinde de #${it.after_id}, care e ${dep}`);
        log(`${tag(it)} EȘUAT: depinde de #${it.after_id} (${dep})`);
        continue;
      }
      if (dep && !["done", "skipped", "sent"].includes(dep)) {
        await touch(it.id, `aștept #${it.after_id} (${dep})`);
        continue;
      }
    }
    try {
      if (pushed.has(it.product_id)) {
        await setStatus(it.id, "done", pushed.get(it.product_id));
        continue;
      }
      const preview = await buildPayload(it.product_id);
      if (!preview.changed) {
        await setStatus(it.id, "skipped", "în Base e deja la fel; nimic de trimis");
        log(`${tag(it)} SĂRIT: deja la zi în Base`);
        continue;
      }
      if (!send) {
        const why = preview.warnings.length ? ` (${preview.warnings.join("; ")})` : "";
        log(`${tag(it)} AR TRIMITE în Base${why}`);
        await touch(it.id, `gata de trimis în Base (BASE_SEND=0)${why}`);
        continue;
      }
      const res = await pushProductToBase(it.product_id);
      if (res.dry_run) {
        await touch(it.id, "gata de trimis în Base (BASE_SEND=0)");
        continue;
      }
      const msg = `${res.created ? "creat" : "actualizat"} în Base (#${res.base_product_id})`;
      await query(
        `UPDATE emag_push_queue SET status='done', attempts=attempts+1, sent_at=now(), done_at=now(),
           last_message=$2, updated_at=now() WHERE id=$1`,
        [it.id, msg]
      );
      pushed.set(it.product_id, msg);
      log(`${tag(it)} TRIMIS: ${msg}`);
    } catch (e) {
      const attempts = it.attempts + 1;
      if (attempts < it.max_attempts) {
        await query(
          `UPDATE emag_push_queue SET attempts=$2, not_before=$3, last_message=$4, updated_at=now() WHERE id=$1`,
          [it.id, attempts, new Date(now + RETRY_MS), `eroare: ${e.message}`]
        );
      } else {
        await query(`UPDATE emag_push_queue SET attempts=$2 WHERE id=$1`, [it.id, attempts]);
        await setStatus(it.id, "failed", `eroare: ${e.message}`);
      }
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
};
