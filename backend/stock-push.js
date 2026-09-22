const { query } = require("./pg");
const { getChannel, listChannels } = require("./channels");
const { getChannelRemotes } = require("./marketplace-db");
const { pushOffersForChannel } = require("./channel-push");
const { log } = require("./logs-db");

// Dupa o comanda (sau anulare), stocul nou din catalog pleaca pe celelalte canale.
// Canalul de origine si-a ajustat deja singur stocul.
const FLUSH_DELAY_MS = 5000;
const MAX_ATTEMPTS = 3;

/** @type {Map<string, { originChannels: Set<string>, attempts: number }>} */
const pending = new Map();
let timer = null;
let running = false;

function enabled() {
  return String(process.env.AUTO_STOCK_PUSH ?? "1").trim() !== "0";
}

/** Pune produsele in coada; flush-ul pleaca dupa FLUSH_DELAY_MS, ca liniile apropiate sa mearga intr-un lot. */
function scheduleStockPush(productIds, { originChannel } = {}) {
  if (!enabled()) return;
  for (const raw of productIds || []) {
    if (raw == null) continue;
    const id = String(raw);
    const entry = pending.get(id) || { originChannels: new Set(), attempts: 0 };
    if (originChannel) entry.originChannels.add(originChannel);
    pending.set(id, entry);
  }
  if (pending.size > 0) armTimer();
}

function armTimer() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

/** Id-ul ofertei pe canal pentru un rand din catalog (eMAG: offer id, Trendyol: barcode = EAN). */
function externalIdFor(channelId, row) {
  if (channelId === "emag") return row.emag_offer_id ? String(row.emag_offer_id).trim() : null;
  if (channelId === "trendyol") {
    const ean = row.ean ? String(row.ean).split(",")[0].trim() : "";
    return ean || null;
  }
  return null;
}

/** Remote-ul fiecarei oferte: din oglinda daca e acolo, altfel citit punctual de pe canal. */
async function loadRemotes(channelId, externalIds) {
  const channel = getChannel(channelId);
  const cache = getChannelRemotes(channelId);
  const remotes = new Map();
  for (const id of externalIds) {
    const cached = cache?.byId.get(id);
    if (cached) {
      remotes.set(id, cached);
      continue;
    }
    const result = await channel.fetchListings({ filters: { id } });
    const listings = result.listings || [];
    const remote = listings.find((o) => String(o.id) === id) || listings[0];
    if (remote) remotes.set(id, remote);
  }
  return remotes;
}

async function pushChannel(channelId, rows) {
  const byExternal = new Map();
  for (const row of rows) {
    const ext = externalIdFor(channelId, row);
    if (ext) byExternal.set(ext, row);
  }
  if (byExternal.size === 0) return { pushed: [], missing: [] };

  const remotes = await loadRemotes(channelId, [...byExternal.keys()]);
  const pushable = [...byExternal.keys()].filter((id) => remotes.has(id));
  const missing = [...byExternal.keys()].filter((id) => !remotes.has(id));
  if (pushable.length > 0) {
    await pushOffersForChannel(
      channelId,
      pushable.map((id) => ({ id, includeStock: true })),
      { remotes, keepRemotePrice: true }
    );
  }
  return {
    pushed: pushable.map((id) => ({
      external_id: id,
      product_id: byExternal.get(id).id,
      stock: byExternal.get(id).general_stock,
    })),
    missing,
  };
}

async function flush() {
  if (running) {
    armTimer();
    return;
  }
  if (pending.size === 0) return;
  running = true;
  const batch = new Map(pending);
  pending.clear();
  try {
    const { rows } = await query(
      `SELECT id, emag_offer_id, ean, general_stock FROM catalog_products WHERE id = ANY($1::int[])`,
      [[...batch.keys()].map(Number)]
    );
    const channels = (await listChannels()).filter((c) => c.configured);

    for (const ch of channels) {
      // Sarim canalul doar daca toate comenzile pe produs au venit de acolo;
      // vanzari pe ambele canale ⇒ fiecare trebuie sa afle de scaderea celuilalt.
      const targets = rows.filter((r) => {
        const origins = batch.get(String(r.id))?.originChannels || new Set();
        return !(origins.size === 1 && origins.has(ch.id));
      });
      if (targets.length === 0) continue;
      try {
        const { pushed, missing } = await pushChannel(ch.id, targets);
        if (pushed.length === 0 && missing.length === 0) continue;
        console.log(`[stock-push] ${ch.id}: ${pushed.length} oferte trimise, ${missing.length} negasite pe canal`);
        void log({
          level: missing.length ? "warn" : "info",
          source: "server",
          category: "stock-push",
          message: `Stoc trimis pe ${ch.label}: ${pushed.length} oferte` +
            (missing.length ? `, ${missing.length} negasite pe canal` : ""),
          detail: { channel: ch.id, pushed, missing },
        });
      } catch (err) {
        console.error(`[stock-push] ${ch.id}:`, err.message);
        const retry = [];
        for (const r of targets) {
          const entry = batch.get(String(r.id));
          if (!entry || entry.attempts + 1 >= MAX_ATTEMPTS) continue;
          const again = pending.get(String(r.id)) || { originChannels: new Set(entry.originChannels), attempts: 0 };
          again.attempts = Math.max(again.attempts, entry.attempts + 1);
          pending.set(String(r.id), again);
          retry.push(r.id);
        }
        void log({
          level: "error",
          source: "server",
          category: "stock-push",
          message: `Push stoc pe ${ch.label} esuat: ${err.message}` +
            (retry.length ? ` (reincerc ${retry.length})` : " (renunt — foloseste Publica tot pe canale)"),
          detail: { channel: ch.id, product_ids: targets.map((r) => r.id), retry, stack: err.stack },
        });
      }
    }
  } catch (err) {
    console.error("[stock-push]", err.message);
    void log({
      level: "error",
      source: "server",
      category: "stock-push",
      message: `Push stoc esuat: ${err.message}`,
      detail: { product_ids: [...batch.keys()], stack: err.stack },
    });
  } finally {
    running = false;
    if (pending.size > 0) armTimer();
  }
}

module.exports = { scheduleStockPush };
