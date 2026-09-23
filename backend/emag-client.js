const fs = require("fs");
const https = require("https");
const path = require("path");
const { log, truncate } = require("./logs-db");

const EMAG_API = "https://marketplace-api.emag.ro/api-3";
// Platformele eMAG: acelasi cont, endpoint-uri diferite.
const EMAG_HOSTS = {
  ro: "marketplace-api.emag.ro",
  bg: "marketplace-api.emag.bg",
  hu: "marketplace-api.emag.hu",
};

/** URL-ul de baza al API-ului pentru o platforma eMAG ('ro' implicit). */
function emagApiBase(platform) {
  const key = String(platform || "ro").trim().toLowerCase();
  const host = EMAG_HOSTS[key];
  if (!host) {
    const err = new Error(`Platforma eMAG necunoscuta: ${key}`);
    err.status = 400;
    throw err;
  }
  return `https://${host}/api-3`;
}
const ITEMS_PER_PAGE = 100;
const EMAG_REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.EMAG_REQUEST_TIMEOUT_MS) || 45_000
);
const EMAG_MAX_RESPONSE_BYTES = Math.max(
  1_000_000,
  Number(process.env.EMAG_MAX_RESPONSE_BYTES) || 15_000_000
);
const AUTH_CACHE_PATH = path.join(__dirname, "data", "auth-preferred.json");
// eMAG marketplace cert currently expired (CERT_HAS_EXPIRED) — scoped bypass only for this host
const EMAG_HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

function emagFetch(url, { method = "GET", headers = {}, body } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body == null ? null : Buffer.from(String(body), "utf8");
    const reqHeaders = { ...headers };
    if (payload) reqHeaders["Content-Length"] = payload.length;

    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method,
        headers: reqHeaders,
        agent: EMAG_HTTPS_AGENT,
      },
      (res) => {
        const chunks = [];
        let responseBytes = 0;
        let responseTooLarge = false;
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (responseTooLarge) return;
          const text = Buffer.concat(chunks).toString("utf8");
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          void log({
            level: ok ? "debug" : "error",
            source: "emag",
            category: "http",
            message: `${method} ${parsed.pathname} → HTTP ${res.statusCode}`,
            status: res.statusCode,
            durationMs: Date.now() - startedAt,
            detail: {
              url,
              method,
              requestHeaders: headers,
              requestBody: body == null ? null : truncate(String(body), 3000),
              responseBody: truncate(text, 4000),
            },
          });
          resolve({
            status: res.statusCode,
            ok,
            text: async () => text,
          });
        });
        res.on("data", (c) => {
          responseBytes += c.length;
          if (responseBytes > EMAG_MAX_RESPONSE_BYTES) {
            responseTooLarge = true;
            req.destroy(
              new Error(
                `Răspuns eMAG prea mare (peste ${EMAG_MAX_RESPONSE_BYTES} bytes)`
              )
            );
          }
        });
      }
    );
    req.setTimeout(EMAG_REQUEST_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`Timeout eMAG după ${Math.round(EMAG_REQUEST_TIMEOUT_MS / 1000)} secunde`)
      );
    });
    req.on("error", (err) => {
      void log({
        level: "error",
        source: "emag",
        category: "http",
        message: `${method} ${parsed.pathname} — eroare retea: ${err.message}`,
        durationMs: Date.now() - startedAt,
        detail: { url, method, stack: err.stack },
      });
      reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const { loadCredentials } = require("./credentials-store");

function authHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function loadPreferredAuthLabel() {
  try {
    if (!fs.existsSync(AUTH_CACHE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(AUTH_CACHE_PATH, "utf8"));
    return typeof raw?.label === "string" ? raw.label : null;
  } catch {
    return null;
  }
}

function savePreferredAuthLabel(label) {
  try {
    fs.mkdirSync(path.dirname(AUTH_CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      AUTH_CACHE_PATH,
      JSON.stringify({ label, savedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
  } catch (err) {
    console.warn("[auth] nu am putut salva preferred auth:", err.message);
  }
}

function authCandidates(creds) {
  const list = [
    {
      label: "email+password",
      user: creds.USER_EMAIL,
      pass: creds.ACCOUNT_PASSWORD,
      userHint: "email",
      passHint: "ACCOUNT_PASSWORD",
    },
    {
      label: "email+api_code",
      user: creds.USER_EMAIL,
      pass: creds.API_CODE,
      userHint: "email",
      passHint: "API_CODE",
    },
    {
      label: "api_code+password",
      user: creds.API_CODE,
      pass: creds.ACCOUNT_PASSWORD,
      userHint: "API_CODE",
      passHint: "ACCOUNT_PASSWORD",
    },
  ].filter((c) => c.user && c.pass);

  const preferred = loadPreferredAuthLabel();
  if (!preferred) return list;

  const idx = list.findIndex((c) => c.label === preferred);
  if (idx <= 0) return list;

  const ordered = [list[idx], ...list.filter((_, i) => i !== idx)];
  console.log(`[auth] preferred "${preferred}" mutat primul în listă`);
  return ordered;
}

function logAuthAttempt(context, candidate, index, total) {
  console.log(
    `[auth:${context}] încerc ${index + 1}/${total} label=${candidate.label} ` +
      `user=${candidate.userHint} pass=${candidate.passHint}`
  );
  void log({
    level: "debug",
    source: "emag",
    category: "auth",
    message: `[${context}] incerc ${index + 1}/${total} label=${candidate.label}`,
    detail: { context, label: candidate.label, userHint: candidate.userHint, passHint: candidate.passHint },
  });
}

function logAuthResult(context, candidate, status, ok) {
  void log({
    level: ok ? "info" : status === 401 || status === 403 ? "error" : "warn",
    source: "emag",
    category: "auth",
    message: ok
      ? `[${context}] SUCCES label=${candidate.label}`
      : `[${context}] ${status === 401 || status === 403 ? "ESUAT" : "raspuns non-auth"} label=${candidate.label}`,
    status,
    detail: { context, label: candidate.label },
  });
  if (ok) {
    console.log(
      `[auth:${context}] SUCCES label=${candidate.label} HTTP ${status} — salvat ca preferred`
    );
  } else if (status === 401 || status === 403) {
    console.warn(
      `[auth:${context}] EȘUAT label=${candidate.label} HTTP ${status}`
    );
  } else {
    console.log(
      `[auth:${context}] răspuns non-auth label=${candidate.label} HTTP ${status}`
    );
  }
}

async function emagOrderRead(
  auth,
  { page = 1, id, status, createdAfter, createdBefore, modifiedAfter, modifiedBefore }
) {
  const body = new URLSearchParams();
  body.set("currentPage", String(page));
  body.set("itemsPerPage", String(ITEMS_PER_PAGE));
  if (id != null && id !== "") body.set("id", String(id));
  if (modifiedAfter) body.set("modifiedAfter", String(modifiedAfter));
  if (modifiedBefore) body.set("modifiedBefore", String(modifiedBefore));

  if (status != null && status !== "") {
    const statuses = Array.isArray(status) ? status : [status];
    statuses.forEach((s, i) => {
      body.set(`status[${i}]`, String(s));
    });
  }
  if (createdAfter) body.set("createdAfter", String(createdAfter));
  if (createdBefore) body.set("createdBefore", String(createdBefore));

  const response = await emagFetch(`${EMAG_API}/order/read`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { response, json, text };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Local datetime → eMAG `YYYY-mm-dd HH:ii:ss` */
function toEmagDatetime(d) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

let cachedAuth = null;

/**
 * Header Authorization valid pentru eMAG: incearca combinatiile de credentiale
 * cu un order/read pe ultimul minut. Rezultatul e tinut in memorie; `fresh` il ignora.
 */
async function resolveEmagAuth(context, { fresh = false } = {}) {
  if (cachedAuth && !fresh) return cachedAuth;
  cachedAuth = null;

  const creds = await loadCredentials();
  const candidates = authCandidates(creds);
  let lastStatus = null;
  let lastText = "";

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    logAuthAttempt(context, candidate, i, candidates.length);
    const auth = authHeader(candidate.user, candidate.pass);
    const { response, json, text } = await emagOrderRead(auth, {
      page: 1,
      createdAfter: toEmagDatetime(new Date(Date.now() - 60 * 1000)),
      createdBefore: toEmagDatetime(new Date()),
    });
    lastStatus = response.status;
    lastText = text;

    if (response.status === 401 || response.status === 403) {
      logAuthResult(context, candidate, response.status, false);
      continue;
    }

    logAuthResult(context, candidate, response.status, true);
    savePreferredAuthLabel(candidate.label);

    if (!json) {
      throw new Error(`Răspuns invalid de la eMAG (HTTP ${response.status}): ${text.slice(0, 300)}`);
    }
    if (json.isError) {
      throw new Error(`eMAG eroare la probe auth: ${JSON.stringify(json.messages || [])}`);
    }

    cachedAuth = auth;
    return auth;
  }

  throw new Error(
    `Autentificare eMAG eșuată (HTTP ${lastStatus || "?"}). ${lastText.slice(0, 200)}`
  );
}

module.exports = {
  EMAG_API,
  EMAG_HOSTS,
  emagApiBase,
  toEmagDatetime,
  resolveEmagAuth,
  ITEMS_PER_PAGE,
  emagFetch,
  loadCredentials,
  authHeader,
  authCandidates,
  savePreferredAuthLabel,
  logAuthAttempt,
  logAuthResult,
  emagOrderRead,
};
