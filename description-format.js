/**
 * Descrierea traieste ca text curat in DB si in UI (paragrafe separate prin rand liber).
 * HTML-ul exista doar la marginea eMAG: se curata la pull, se re-genereaza la push.
 */

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  laquo: "\u00ab",
  raquo: "\u00bb",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  deg: "\u00b0",
};

const BLOCK_CLOSE = /<\/(?:p|div|ul|ol|h[1-6]|tr|table|blockquote)\s*>/gi;
const BLOCK_OPEN = /<(?:p|div|ul|ol|h[1-6]|tr|table|blockquote)\b[^>]*>/gi;
const HTML_MARKERS =
  /<\/?(?:p|br|div|ul|ol|li|h[1-6]|span|strong|em|b|i|a|table|tr|td|blockquote)\b[^>]*>|&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i;

function decodeEntities(s) {
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** HTML (de la eMAG sau lipit de utilizator) -> text curat, paragrafe separate prin rand liber. */
function htmlToText(html) {
  if (html == null) return "";
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(BLOCK_CLOSE, "\n\n");
  s = s.replace(BLOCK_OPEN, "\n\n");
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/[^\S\n]+/g, " ");
  s = s
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text curat -> HTML pentru eMAG: un <p> per bloc, \n in interiorul blocului -> <br>. */
function textToHtml(text) {
  if (text == null) return "";
  const normalized = String(text).replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  return normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).split("\n").join("<br>")}</p>`)
    .join(" ");
}

/** Euristica pentru migrare / protectie la salvare: valoarea contine markup sau entitati? */
function looksLikeHtml(value) {
  if (value == null) return false;
  return HTML_MARKERS.test(String(value));
}

module.exports = { htmlToText, textToHtml, looksLikeHtml };
