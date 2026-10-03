/**
 * Diff intre starea de dinainte si cea de dupa o salvare, pentru /logs.html:
 * ce campuri s-au schimbat, cu valoarea veche si cea noua.
 */

const MAX_DETAIL_VALUE_CHARS = 1500;
const MAX_MESSAGE_VALUE_CHARS = 60;
const MAX_LABEL_CHARS = 50;

/** Aplatizeaza obiectele imbricate in chei cu punct (calculator_params.curs_usd). */
function flatten(obj, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      flatten(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

function comparable(value) {
  if (value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") return JSON.stringify(value);
  return value;
}

/** NUMERIC din Postgres vine ca "53.9900" — il aratam ca numar (53.99). */
function displayValue(value) {
  const v = comparable(value);
  if (typeof v === "string" && /^-?\d+\.\d+$/.test(v)) return Number(v);
  return v;
}

function clip(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Campurile care difera intre `before` si `after`, ca [{ field, from, to }].
 * `only` (Set) restrange la cheile de prim nivel date; `ignore` (Set) le exclude.
 */
function diffFields(before, after, { only = null, ignore = null } = {}) {
  const a = flatten(before);
  const b = flatten(after);
  const changes = [];
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const top = field.split(".")[0];
    if (only && !only.has(top)) continue;
    if (ignore && ignore.has(top)) continue;
    if (JSON.stringify(comparable(a[field])) === JSON.stringify(comparable(b[field]))) continue;
    const from = displayValue(a[field]);
    const to = displayValue(b[field]);
    changes.push({
      field,
      from: typeof from === "string" ? clip(from, MAX_DETAIL_VALUE_CHARS) : from,
      to: typeof to === "string" ? clip(to, MAX_DETAIL_VALUE_CHARS) : to,
    });
  }
  return changes;
}

function formatValue(value) {
  if (value == null) return "(gol)";
  if (typeof value === "string") {
    return `"${clip(value.replace(/\s+/g, " ").trim(), MAX_MESSAGE_VALUE_CHARS)}"`;
  }
  return String(value);
}

/** "sale_price: 120 → 130; general_stock: 5 → 3" */
function summarizeChanges(changes) {
  if (!changes.length) return "nicio modificare";
  return changes
    .map((c) => `${c.field}: ${formatValue(c.from)} → ${formatValue(c.to)}`)
    .join("; ");
}

/** "#12 ABC-1 «Lampa LED»" — identifica produsul in mesajul de log. */
function productLabel(row) {
  if (!row) return "";
  const parts = [`#${row.product_id ?? row.id}`];
  if (row.cod_produs) parts.push(String(row.cod_produs));
  if (row.nume) parts.push(`«${clip(String(row.nume).trim(), MAX_LABEL_CHARS)}»`);
  return parts.join(" ");
}

module.exports = { diffFields, summarizeChanges, productLabel };
