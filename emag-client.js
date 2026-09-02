const fs = require("fs");
const https = require("https");
const path = require("path");

const EMAG_API = "https://marketplace-api.emag.ro/api-3";
const ITEMS_PER_PAGE = 100;
const AUTH_CACHE_PATH = path.join(__dirname, "data", "auth-preferred.json");
// eMAG marketplace cert currently expired (CERT_HAS_EXPIRED) — scoped bypass only for this host
const EMAG_HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

function emagFetch(url, { method = "GET", headers = {}, body } = {}) {
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
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            text: async () => text,
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function loadCredentials() {
  const filePath = path.join(__dirname, "credentials.json");
  if (!fs.existsSync(filePath)) {
    throw new Error("Lipsește credentials.json");
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw.USER_EMAIL || !raw.ACCOUNT_PASSWORD) {
    throw new Error("credentials.json trebuie să conțină USER_EMAIL și ACCOUNT_PASSWORD");
  }
  return raw;
}

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
}

function logAuthResult(context, candidate, status, ok) {
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

async function emagOrderRead(auth, { page, status, createdAfter, createdBefore }) {
  const body = new URLSearchParams();
  body.set("currentPage", String(page));
  body.set("itemsPerPage", String(ITEMS_PER_PAGE));

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

module.exports = {
  EMAG_API,
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
