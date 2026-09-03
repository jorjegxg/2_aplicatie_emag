const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "data", "products.db");
const MAX_DETAIL_CHARS = 8000;
const LEVELS = new Set(["debug", "info", "warn", "error"]);

let db = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      duration_ms INTEGER,
      status INTEGER,
      detail TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_app_logs_ts ON app_logs(ts DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs(level, ts DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_app_logs_cat ON app_logs(category, ts DESC);`);
  return db;
}

/** Taie textele lungi (payload eMAG brut) ca sa nu umfle DB-ul. */
function truncate(text, max = MAX_DETAIL_CHARS) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… [trunchiat ${s.length - max} caractere]`;
}

/** Ascunde credentialele inainte de scriere (Authorization, password, token...). */
function redact(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (/authorization|password|api_?code|token|secret/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redact(val, depth + 1);
    }
  }
  return out;
}

/** null/undefined/"" raman NULL in DB - Number(null) ar da 0 si ar afisa "0 ms". */
function toNullableNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function serializeDetail(detail) {
  if (detail == null) return null;
  try {
    if (typeof detail === "string") return truncate(detail);
    return truncate(JSON.stringify(redact(detail), null, 2));
  } catch {
    return truncate(String(detail));
  }
}

/**
 * Scrie o intrare in log. Nu arunca niciodata - logging-ul nu trebuie
 * sa strice request-ul care l-a declansat.
 */
function log({
  level = "info",
  source = "server",
  category = "general",
  message = "",
  durationMs = null,
  status = null,
  detail = null,
  ts = null,
} = {}) {
  try {
    getDb()
      .prepare(
        `INSERT INTO app_logs (ts, level, source, category, message, duration_ms, status, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ts || new Date().toISOString(),
        LEVELS.has(level) ? level : "info",
        String(source).slice(0, 40),
        String(category).slice(0, 60),
        truncate(message, 2000),
        toNullableNumber(durationMs) == null ? null : Math.round(toNullableNumber(durationMs)),
        toNullableNumber(status),
        serializeDetail(detail)
      );
  } catch {
    /* ignorat intentionat */
  }
}

function queryLogs({
  level,
  source,
  category,
  q,
  from,
  to,
  limit = 200,
  offset = 0,
} = {}) {
  const where = [];
  const params = [];

  const levels = Array.isArray(level) ? level : level ? [level] : [];
  const validLevels = levels.filter((l) => LEVELS.has(l));
  if (validLevels.length) {
    where.push(`level IN (${validLevels.map(() => "?").join(", ")})`);
    params.push(...validLevels);
  }
  if (source) {
    where.push("source = ?");
    params.push(String(source));
  }
  if (category) {
    where.push("category = ?");
    params.push(String(category));
  }
  if (q) {
    where.push("(message LIKE ? OR detail LIKE ?)");
    const like = `%${String(q)}%`;
    params.push(like, like);
  }
  if (from) {
    where.push("ts >= ?");
    params.push(String(from));
  }
  if (to) {
    where.push("ts <= ?");
    params.push(String(to));
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const database = getDb();
  const total = database
    .prepare(`SELECT COUNT(*) AS n FROM app_logs ${clause}`)
    .get(...params).n;

  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const rows = database
    .prepare(
      `SELECT * FROM app_logs ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, safeLimit, safeOffset);

  return { rows, total, limit: safeLimit, offset: safeOffset };
}

function getLogFacets() {
  const database = getDb();
  return {
    categories: database
      .prepare("SELECT DISTINCT category FROM app_logs ORDER BY category")
      .all()
      .map((r) => r.category),
    sources: database
      .prepare("SELECT DISTINCT source FROM app_logs ORDER BY source")
      .all()
      .map((r) => r.source),
  };
}

function clearLogs() {
  return getDb().prepare("DELETE FROM app_logs").run().changes;
}

/** Sterge intrarile mai vechi de `days` zile. Apelat la pornirea serverului. */
function pruneLogs(days = 14) {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return getDb().prepare("DELETE FROM app_logs WHERE ts < ?").run(cutoff).changes;
  } catch {
    return 0;
  }
}

module.exports = {
  log,
  queryLogs,
  getLogFacets,
  clearLogs,
  pruneLogs,
  truncate,
  redact,
};
