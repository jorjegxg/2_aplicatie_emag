const crypto = require("crypto");

const COOKIE_NAME = "emag_access";
const SESSION_DAYS = 365;
const PUBLIC_API = new Set([
  "/api/health",
  "/api/auth/status",
  "/api/auth/login",
]);

function appPassword() {
  return String(process.env.APP_PASSWORD || "").trim();
}

function isAuthEnabled() {
  return appPassword().length > 0;
}

function sessionSecret() {
  const fromEnv = String(process.env.APP_SESSION_SECRET || "").trim();
  if (fromEnv) return fromEnv;
  const enc = String(process.env.CREDENTIALS_ENCRYPTION_KEY || "").trim();
  if (enc) return enc;
  return "emag-dev-session-secret";
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    let val = part.slice(idx + 1).trim();
    try {
      val = decodeURIComponent(val);
    } catch {
      /* keep raw */
    }
    out[key] = val;
  }
  return out;
}

function sign(payloadB64) {
  return crypto
    .createHmac("sha256", sessionSecret())
    .update(payloadB64)
    .digest("base64url");
}

function createSessionToken() {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payloadB64 = Buffer.from(JSON.stringify({ exp }), "utf8").toString(
    "base64url"
  );
  return `${payloadB64}.${sign(payloadB64)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    );
    return Number(payload.exp) > Date.now();
  } catch {
    return false;
  }
}

function passwordsMatch(provided) {
  const expected = appPassword();
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still compare to keep timing roughly flat for wrong length.
    crypto.timingSafeEqual(
      crypto.createHash("sha256").update(a).digest(),
      crypto.createHash("sha256").update(b).digest()
    );
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return proto === "https";
}

function cookieOptions(req, { clear = false } = {}) {
  const maxAge = clear ? 0 : SESSION_DAYS * 24 * 60 * 60;
  const parts = [
    `${COOKIE_NAME}=${clear ? "" : encodeURIComponent(createSessionToken())}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function readSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

function requireAppAuth(req, res, next) {
  if (!isAuthEnabled()) return next();

  const pathOnly = req.path.split("?")[0];
  if (PUBLIC_API.has(pathOnly)) return next();
  if (!pathOnly.startsWith("/api/") && !pathOnly.startsWith("/uploads/")) {
    return next();
  }
  if (readSession(req)) return next();

  return res.status(401).json({ error: "Neautentificat", code: "AUTH_REQUIRED" });
}

function authStatusHandler(req, res) {
  const enabled = isAuthEnabled();
  if (!enabled) {
    return res.json({ ok: true, required: false });
  }
  return res.json({ ok: readSession(req), required: true });
}

function authLoginHandler(req, res) {
  if (!isAuthEnabled()) {
    return res.json({ ok: true, required: false });
  }
  const password = String(req.body?.password ?? "");
  if (!passwordsMatch(password)) {
    return res.status(401).json({ error: "Parolă greșită" });
  }
  res.setHeader("Set-Cookie", cookieOptions(req));
  return res.json({ ok: true });
}

function authLogoutHandler(req, res) {
  res.setHeader("Set-Cookie", cookieOptions(req, { clear: true }));
  return res.json({ ok: true });
}

module.exports = {
  COOKIE_NAME,
  isAuthEnabled,
  requireAppAuth,
  authStatusHandler,
  authLoginHandler,
  authLogoutHandler,
};
