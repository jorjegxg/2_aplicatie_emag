/**
 * Trimiterea directa spre eMAG/Trendyol e oprita: tot ce pleaca din aplicatie merge prin Base.
 * Raman doar citirile (eMAG: .../read, .../count, GET; Trendyol: GET).
 */
const BLOCKED_MESSAGE = "Trimiterea directă e oprită — totul merge prin Base";

function blockedError(target) {
  const err = new Error(`${BLOCKED_MESSAGE} (${target})`);
  err.status = 403;
  err.expected = true;
  err.directWriteBlocked = true;
  return err;
}

/** eMAG foloseste POST si pentru citiri: decide dupa ultimul segment din cale. */
function assertEmagReadOnly(url, method) {
  const { hostname, pathname } = new URL(url);
  if (!hostname.startsWith("marketplace-api.emag.")) return;
  if (String(method).toUpperCase() === "GET") return;
  const last = pathname.split("/").filter(Boolean).pop() || "";
  if (last === "read" || last === "count") return;
  throw blockedError(`eMAG ${pathname}`);
}

function assertTrendyolReadOnly(method, path) {
  if (String(method).toUpperCase() === "GET") return;
  throw blockedError(`Trendyol ${path}`);
}

module.exports = { BLOCKED_MESSAGE, assertEmagReadOnly, assertTrendyolReadOnly };
