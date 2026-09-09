/**
 * Cache in-memorie pentru oglinda remote a canalului (eMAG).
 * Se golește la restart sau la expirarea TTL.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function resolveTtlMs() {
  const raw = Number(process.env.CHANNEL_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_TTL_MS;
}

/** @type {Map<string, { fetchedAt: string, byId: Map<string, object> }>} */
const store = new Map();

function normalizeChannel(channel) {
  return String(channel || "emag").trim().toLowerCase() || "emag";
}

function isFresh(entry, now = Date.now()) {
  if (!entry?.fetchedAt) return false;
  const ts = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(ts)) return false;
  return now - ts <= resolveTtlMs();
}

/**
 * Înlocuire atomică a setului de oferte remote pentru un canal.
 * @param {string} channel
 * @param {object[]} listings — obiecte remote (cu .id)
 * @param {string} [fetchedAt]
 */
function setChannelRemotes(channel, listings, fetchedAt) {
  const ch = normalizeChannel(channel);
  const byId = new Map();
  for (const remote of listings || []) {
    if (remote == null || remote.id == null) continue;
    byId.set(String(remote.id), remote);
  }
  store.set(ch, {
    fetchedAt: fetchedAt || new Date().toISOString(),
    byId,
  });
}

/**
 * Actualizeaza o singura oferta din oglinda, fara sa atinga restul.
 * `setChannelRemotes` inlocuieste tot setul, deci nu poate fi folosit pentru
 * preluarea unui singur rand.
 * @param {string} channel
 * @param {object} remote — oferta remote (cu .id)
 * @returns {boolean} true daca s-a scris
 */
function upsertChannelRemote(channel, remote) {
  if (remote == null || remote.id == null) return false;
  const ch = normalizeChannel(channel);
  let entry = store.get(ch);
  if (!entry || !isFresh(entry)) {
    entry = { fetchedAt: new Date().toISOString(), byId: new Map() };
    store.set(ch, entry);
  }
  entry.byId.set(String(remote.id), remote);
  return true;
}

/** @returns {{ fetchedAt: string, byId: Map<string, object> } | null} */
function getChannelRemotes(channel) {
  const ch = normalizeChannel(channel);
  const entry = store.get(ch);
  if (!entry || !isFresh(entry)) {
    if (entry && !isFresh(entry)) store.delete(ch);
    return null;
  }
  return entry;
}

function getCacheMeta(channel) {
  const entry = getChannelRemotes(channel);
  if (!entry) return { count: 0, fetchedAt: null, fresh: false };
  return {
    count: entry.byId.size,
    fetchedAt: entry.fetchedAt,
    fresh: true,
  };
}

function clearChannelCache(channel) {
  store.delete(normalizeChannel(channel));
}

module.exports = {
  setChannelRemotes,
  upsertChannelRemote,
  getChannelRemotes,
  getCacheMeta,
  clearChannelCache,
  resolveTtlMs,
};
