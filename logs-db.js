const { query, ensureSchema } = require("./pg");

const MAX_DETAIL_CHARS = 8000;
const LEVELS = new Set(["debug", "info", "warn", "error"]);

function truncate(text, max = MAX_DETAIL_CHARS) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… [trunchiat ${s.length - max} caractere]`;
}

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

async function log({
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
    await ensureSchema();
    await query(
      `INSERT INTO app_logs (ts, level, source, category, message, duration_ms, status, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ts || new Date().toISOString(),
        LEVELS.has(level) ? level : "info",
        String(source).slice(0, 40),
        String(category).slice(0, 60),
        truncate(message, 2000),
        toNullableNumber(durationMs) == null
          ? null
          : Math.round(toNullableNumber(durationMs)),
        toNullableNumber(status),
        serializeDetail(detail),
      ]
    );
  } catch {
    /* ignorat intentionat */
  }
}

async function queryLogs({
  level,
  source,
  category,
  q,
  from,
  to,
  limit = 200,
  offset = 0,
} = {}) {
  await ensureSchema();
  const where = [];
  const params = [];

  const levels = Array.isArray(level) ? level : level ? [level] : [];
  const validLevels = levels.filter((l) => LEVELS.has(l));
  if (validLevels.length) {
    params.push(validLevels);
    where.push(`level = ANY($${params.length}::text[])`);
  }
  if (source) {
    params.push(String(source));
    where.push(`source = $${params.length}`);
  }
  if (category) {
    params.push(String(category));
    where.push(`category = $${params.length}`);
  }
  if (q) {
    const like = `%${String(q)}%`;
    params.push(like, like);
    where.push(
      `(message ILIKE $${params.length - 1} OR detail ILIKE $${params.length})`
    );
  }
  if (from) {
    params.push(String(from));
    where.push(`ts >= $${params.length}`);
  }
  if (to) {
    params.push(String(to));
    where.push(`ts <= $${params.length}`);
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS n FROM app_logs ${clause}`,
    params
  );
  const total = countRows[0]?.n ?? 0;

  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  params.push(safeLimit, safeOffset);
  const { rows } = await query(
    `SELECT * FROM app_logs ${clause}
     ORDER BY ts DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { rows, total, limit: safeLimit, offset: safeOffset };
}

async function getLogFacets() {
  await ensureSchema();
  const { rows: categories } = await query(
    "SELECT DISTINCT category FROM app_logs ORDER BY category"
  );
  const { rows: sources } = await query(
    "SELECT DISTINCT source FROM app_logs ORDER BY source"
  );
  return {
    categories: categories.map((r) => r.category),
    sources: sources.map((r) => r.source),
  };
}

async function clearLogs() {
  await ensureSchema();
  const result = await query("DELETE FROM app_logs");
  return result.rowCount ?? 0;
}

async function pruneLogs(days = 14) {
  try {
    await ensureSchema();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = await query("DELETE FROM app_logs WHERE ts < $1", [cutoff]);
    return result.rowCount ?? 0;
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
