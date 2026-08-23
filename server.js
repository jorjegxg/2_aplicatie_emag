const express = require("express");
const fs = require("fs");
const https = require("https");
const path = require("path");
const {
  lookupPretCumparare,
  lookupAlteCosturi,
  saveAlteCosturi,
  clearAlteCosturi,
  lookupPretContabil,
  clearPretContabil,
  savePretContabil,
  lookupPretMinim,
  savePretMinim,
  clearPretMinim,
  lookupCommission,
  lookupCommissionsBulk,
  lookupCostOverridesBulk,
  saveCommissionFromEmag,
  saveProcentajEmag,
  clearProcentajEmag,
  getSettings,
  saveSettings,
} = require("./db");

const PORT = process.env.PORT || 3000;
const EMAG_API = "https://marketplace-api.emag.ro/api-3";
const EMAG_API_V1 = "https://marketplace-api.emag.ro/api/v1";
const COMMISSION_FETCH_CONCURRENCY = 5;
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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

function formatCharacteristics(characteristics) {
  if (!Array.isArray(characteristics) || characteristics.length === 0) {
    return "";
  }
  return characteristics
    .map((c) => {
      const name = c.name || c.id || "?";
      const value = Array.isArray(c.value) ? c.value.join(", ") : c.value ?? "";
      return `${name}: ${value}`;
    })
    .join("; ");
}

function normalizeStock(stock, generalStock) {
  if (Array.isArray(stock) && stock.length > 0) {
    return stock.map((s) => ({
      warehouse_id: Number(s.warehouse_id) || 1,
      value: Number(s.value) || 0,
    }));
  }
  const qty = Number(generalStock);
  return [{ warehouse_id: 1, value: Number.isFinite(qty) ? qty : 0 }];
}

function normalizeHandlingTime(handlingTime) {
  if (Array.isArray(handlingTime) && handlingTime.length > 0) {
    return handlingTime.map((h) => ({
      warehouse_id: Number(h.warehouse_id) || 1,
      value: Number(h.value) || 0,
    }));
  }
  return [{ warehouse_id: 1, value: 0 }];
}

function mapOffer(offer) {
  const ean = Array.isArray(offer.ean) ? offer.ean.join(", ") : offer.ean || "";
  const name = offer.name || "";
  const part_number = offer.part_number || "";
  const fam = Array.isArray(offer.family) ? offer.family[0] : offer.family;
  const commission = lookupCommission(offer.id);
  return {
    id: offer.id,
    name,
    description: offer.description || "",
    brand: offer.brand || offer.brand_name || "",
    part_number,
    part_number_key: offer.part_number_key || "",
    id_familie: fam?.id ?? null,
    familie: fam?.name || "",
    sale_price: offer.sale_price ?? null,
    recommended_price: offer.recommended_price ?? null,
    min_sale_price: offer.min_sale_price ?? null,
    max_sale_price: offer.max_sale_price ?? null,
    pret_cumparare: lookupPretCumparare(part_number, name),
    alte_costuri: lookupAlteCosturi(offer.id),
    pret_contabil: lookupPretContabil(offer.id),
    pret_minim_override: lookupPretMinim(offer.id),
    procentaj_emag: commission?.procentaj_emag ?? null,
    commission_value: commission?.commission_value ?? null,
    commission_fetched_at: commission?.fetched_at ?? null,
    currency: offer.currency || "RON",
    general_stock: offer.general_stock ?? null,
    estimated_stock: offer.estimated_stock ?? null,
    status: offer.status,
    vat_id: offer.vat_id ?? null,
    handling_time: normalizeHandlingTime(offer.handling_time),
    stock: normalizeStock(offer.stock, offer.general_stock),
    ean,
    characteristics: formatCharacteristics(offer.characteristics),
  };
}

async function emagProductOfferRead(auth, page) {
  const body = new URLSearchParams();
  body.set("currentPage", String(page));
  body.set("itemsPerPage", String(ITEMS_PER_PAGE));

  const response = await emagFetch(`${EMAG_API}/product_offer/read`, {
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

function parseCommissionPercent(json) {
  const raw =
    json?.data?.value ??
    json?.data?.commission ??
    json?.value ??
    json?.commission;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

function commissionValueFromPercent(percent, salePrice) {
  const pct = Number(percent);
  const sale = Number(salePrice);
  if (!Number.isFinite(pct) || !Number.isFinite(sale) || sale <= 0) return null;
  return Math.round(sale * (pct / 100) * 100) / 100;
}

async function emagCommissionEstimate(auth, offerId) {
  const response = await emagFetch(
    `${EMAG_API_V1}/commission/estimate/${offerId}`,
    {
      method: "GET",
      headers: { Authorization: auth },
    }
  );
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, json, text };
}

async function resolveEmagAuth(probeFn) {
  const creds = loadCredentials();
  const candidates = authCandidates(creds);
  let lastStatus = null;
  let lastDetail = "";

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    logAuthAttempt("commission", candidate, i, candidates.length);
    const auth = authHeader(candidate.user, candidate.pass);
    const probe = await probeFn(auth);
    lastStatus = probe.status;
    lastDetail = probe.detail || "";

    if (probe.status === 401 || probe.status === 403) {
      logAuthResult("commission", candidate, probe.status, false);
      continue;
    }

    if (probe.ok) {
      logAuthResult("commission", candidate, probe.status, true);
      savePreferredAuthLabel(candidate.label);
      return { auth, label: candidate.label };
    }
  }

  throw new Error(
    lastStatus === 401 || lastStatus === 403
      ? "Autentificare eMAG eșuată (401/403). Verifică credentials și IP whitelist."
      : `eMAG commission API eșuat (HTTP ${lastStatus || "?"}): ${lastDetail.slice(0, 200)}`
  );
}

async function mapPool(items, limit, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}

function mapOrderProduct(product) {
  const name = product.name || product.product_name || "";
  const part_number = product.part_number || "";
  const product_id = product.product_id ?? null;
  const commission = lookupCommission(product_id);
  return {
    id: product.id ?? null,
    product_id,
    name,
    part_number,
    quantity: product.quantity ?? null,
    sale_price: product.sale_price ?? null,
    status: product.status ?? null,
    currency: product.currency || "RON",
    pret_cumparare: lookupPretCumparare(part_number, name),
    alte_costuri: lookupAlteCosturi(product_id),
    pret_contabil: lookupPretContabil(product_id),
    procentaj_emag: commission?.procentaj_emag ?? null,
    commission_value: commission?.commission_value ?? null,
    commission_fetched_at: commission?.fetched_at ?? null,
  };
}

function mapOrder(order) {
  const customerRaw = Array.isArray(order.customer)
    ? order.customer[0]
    : order.customer;
  const products = Array.isArray(order.products)
    ? order.products.map(mapOrderProduct)
    : [];
  return {
    id: order.id,
    status: order.status,
    date: order.date || order.created || null,
    payment_mode_id: order.payment_mode_id ?? null,
    customer_name: customerRaw?.name || customerRaw?.billing_name || "",
    products,
  };
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

app.get("/api/settings", (_req, res) => {
  try {
    return res.json(getSettings());
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la citire setări" });
  }
});

app.post("/api/settings", (req, res) => {
  try {
    const toNum = (v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const saved = saveSettings({
      procentaj_alte_costuri: toNum(req.body?.procentaj_alte_costuri),
      procentaj_pret_contabil: toNum(req.body?.procentaj_pret_contabil),
      mult_prp: toNum(req.body?.mult_prp),
      mult_min: toNum(req.body?.mult_min),
      mult_max: toNum(req.body?.mult_max),
    });

    return res.json(saved);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la salvare setări" });
  }
});

app.post("/api/products/alte-costuri", (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id invalid" });
    }
    const raw = req.body?.alte_costuri;
    if (raw === null || raw === undefined || raw === "") {
      clearAlteCosturi(id);
      return res.json({ ok: true, id, alte_costuri: null });
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return res.status(400).json({ error: "alte_costuri invalid" });
    }
    const saved = saveAlteCosturi(id, n);
    return res.json({ ok: true, id, alte_costuri: saved });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la salvare pret transport" });
  }
});

app.post("/api/products/pret-contabil", (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id invalid" });
    }
    const raw = req.body?.pret_contabil;
    if (raw === null || raw === undefined || raw === "") {
      clearPretContabil(id);
      return res.json({ ok: true, id, pret_contabil: null });
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return res.status(400).json({ error: "pret_contabil invalid" });
    }
    const saved = savePretContabil(id, n);
    return res.json({ ok: true, id, pret_contabil: saved });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la salvare pret contabil" });
  }
});

app.post("/api/products/pret-minim", (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id invalid" });
    }
    const raw = req.body?.pret_minim;
    if (raw === null || raw === undefined || raw === "") {
      clearPretMinim(id);
      return res.json({ ok: true, id, pret_minim: null });
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return res.status(400).json({ error: "pret_minim invalid" });
    }
    const saved = savePretMinim(id, n);
    return res.json({ ok: true, id, pret_minim: saved });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la salvare pret minim" });
  }
});

app.get("/api/products/commissions", (req, res) => {
  try {
    const raw = req.query.ids;
    let ids = [];
    if (typeof raw === "string" && raw.trim()) {
      ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(raw)) {
      ids = raw.flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean);
    }
    const commissions = lookupCommissionsBulk(ids);
    return res.json({ ok: true, commissions });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la citire comisioane" });
  }
});

app.get("/api/products/cost-overrides", (req, res) => {
  try {
    const raw = req.query.ids;
    let ids = [];
    if (typeof raw === "string" && raw.trim()) {
      ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(raw)) {
      ids = raw.flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean);
    }
    const overrides = lookupCostOverridesBulk(ids);
    return res.json({ ok: true, overrides });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la citire cost overrides" });
  }
});

app.post("/api/products/procentaj-emag", (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id invalid" });
    }
    const raw = req.body?.procentaj_emag;
    if (raw === null || raw === undefined || raw === "") {
      clearProcentajEmag(id);
      return res.json({ ok: true, id, procentaj_emag: null });
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return res.status(400).json({ error: "procentaj_emag invalid" });
    }
    const saved = saveProcentajEmag(id, n);
    return res.json({ ok: true, id, procentaj_emag: saved.procentaj_emag });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la salvare procentaj emag" });
  }
});

app.post("/api/products/fetch-commission", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ error: "items lipsă" });
    }

    const normalized = items
      .map((item) => ({
        id: Number(item?.id),
        sale_price: Number(item?.sale_price),
      }))
      .filter((item) => Number.isFinite(item.id));

    if (normalized.length === 0) {
      return res.status(400).json({ error: "niciun id valid" });
    }

    const probeId = normalized[0].id;
    const { auth } = await resolveEmagAuth(async (authHeaderValue) => {
      const { response, json, text } = await emagCommissionEstimate(
        authHeaderValue,
        probeId
      );
      const pct = parseCommissionPercent(json);
      return {
        status: response.status,
        ok: response.ok && pct != null,
        detail: text,
      };
    });

    const fetched = await mapPool(normalized, COMMISSION_FETCH_CONCURRENCY, async (item) => {
      if (!Number.isFinite(item.sale_price) || item.sale_price <= 0) {
        return {
          id: item.id,
          error: "sale_price invalid — reîncarcă produsele",
        };
      }

      try {
        const { response, json, text } = await emagCommissionEstimate(auth, item.id);
        if (response.status === 401 || response.status === 403) {
          return { id: item.id, error: "autentificare eMAG eșuată" };
        }
        if (!response.ok) {
          return {
            id: item.id,
            error: `HTTP ${response.status}: ${text.slice(0, 120)}`,
          };
        }
        const procentaj_emag = parseCommissionPercent(json);
        if (procentaj_emag == null) {
          return {
            id: item.id,
            error: json?.message || "răspuns fără comision",
          };
        }
        const commission_value = commissionValueFromPercent(
          procentaj_emag,
          item.sale_price
        );
        if (commission_value == null) {
          return { id: item.id, error: "comision RON invalid" };
        }
        const saved = saveCommissionFromEmag(item.id, {
          commission_value,
          procentaj_emag,
        });
        return {
          id: item.id,
          procentaj_emag: saved.procentaj_emag,
          commission_value: saved.commission_value,
          fetched_at: saved.fetched_at,
        };
      } catch (err) {
        return { id: item.id, error: err.message || "eroare necunoscută" };
      }
    });

    const results = fetched.filter((r) => !r.error);
    const errors = fetched.filter((r) => r.error);

    return res.json({
      ok: true,
      count: results.length,
      errorCount: errors.length,
      results,
      errors,
    });
  } catch (err) {
    console.error("[fetch-commission]", err.message);
    return res.status(500).json({ error: err.message || "Eroare la preluare comision" });
  }
});

async function emagProductOfferSave(auth, offers) {
  console.log(
    `[eMAG update] POST ${EMAG_API}/product_offer/save — ${offers.length} oferte`
  );
  console.log(
    "[eMAG update] body:",
    JSON.stringify(
      offers.map((o) => ({
        id: o.id,
        name: o.name,
        sale_price: o.sale_price,
        recommended_price: o.recommended_price,
        min_sale_price: o.min_sale_price,
        max_sale_price: o.max_sale_price,
        status: o.status,
        vat_id: o.vat_id,
      }))
    )
  );

  const response = await emagFetch(`${EMAG_API}/product_offer/save`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: offers }),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  console.log(`[eMAG update] HTTP ${response.status}`);
  if (json) {
    console.log(
      `[eMAG update] isError=${Boolean(json.isError)} messages=`,
      json.messages || []
    );
  } else {
    console.log("[eMAG update] răspuns non-JSON:", text.slice(0, 500));
  }

  return { response, json, text };
}

app.post("/api/products/sync-prices", async (req, res) => {
  try {
    const rawOffers = Array.isArray(req.body?.offers) ? req.body.offers : [];
    if (rawOffers.length === 0) {
      return res.status(400).json({ error: "Nicio ofertă de sincronizat" });
    }

    const toNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const offers = [];
    for (const o of rawOffers) {
      const id = toNum(o?.id);
      const sale_price = toNum(o?.sale_price);
      const recommended_price = toNum(o?.recommended_price);
      const min_sale_price = toNum(o?.min_sale_price);
      const max_sale_price = toNum(o?.max_sale_price);
      const status = toNum(o?.status);
      const vat_id = toNum(o?.vat_id);
      if (id == null || sale_price == null) {
        return res.status(400).json({
          error: "Fiecare ofertă trebuie să aibă id și sale_price valide",
        });
      }
      if (status == null || vat_id == null) {
        return res.status(400).json({
          error: `Oferta ${id}: lipsesc status sau vat_id (reîncarcă produsele)`,
        });
      }
      if (recommended_price != null && recommended_price <= sale_price) {
        return res.status(400).json({
          error: `Oferta ${id}: PRP (${recommended_price}) trebuie să fie mai mare decât pretul de vânzare (${sale_price})`,
        });
      }
      const stock = normalizeStock(o?.stock, o?.general_stock);
      const handling_time = normalizeHandlingTime(o?.handling_time);
      const name =
        typeof o?.name === "string" ? o.name.trim() : "";
      const description =
        typeof o?.description === "string" ? o.description : null;
      const payload = {
        id,
        status,
        sale_price,
        vat_id,
        handling_time,
        stock,
      };
      if (name) payload.name = name;
      if (description != null) payload.description = description;
      if (recommended_price != null) payload.recommended_price = recommended_price;
      if (min_sale_price != null) payload.min_sale_price = min_sale_price;
      if (max_sale_price != null) payload.max_sale_price = max_sale_price;
      offers.push(payload);
    }

    console.log(`[sync-prices] start — ${offers.length} oferte de updatat pe eMAG`);

    const creds = loadCredentials();
    const candidates = authCandidates(creds);
    console.log(
      `[auth:sync-prices] ordine încercări:`,
      candidates.map((c) => c.label).join(" → ")
    );

    let lastStatus = null;
    let lastJson = null;
    let lastText = "";

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      logAuthAttempt("sync-prices", candidate, i, candidates.length);
      const auth = authHeader(candidate.user, candidate.pass);
      const { response, json, text } = await emagProductOfferSave(auth, offers);
      lastStatus = response.status;
      lastJson = json;
      lastText = text;

      if (response.status === 401 || response.status === 403) {
        logAuthResult("sync-prices", candidate, response.status, false);
        continue;
      }

      logAuthResult("sync-prices", candidate, response.status, true);
      savePreferredAuthLabel(candidate.label);

      if (!json) {
        console.error("[sync-prices] răspuns invalid de la eMAG", text.slice(0, 500));
        return res.status(502).json({
          error: "Răspuns invalid de la eMAG",
          status: response.status,
          detail: text.slice(0, 500),
        });
      }

      if (json.isError) {
        console.error("[sync-prices] eMAG isError:", json.messages || []);
        return res.status(502).json({
          error: "eMAG a returnat eroare la salvare prețuri",
          messages: json.messages || [],
        });
      }

      console.log(
        `[sync-prices] OK — updatate ${offers.length} oferte pe eMAG (auth=${candidate.label})`,
        offers.map((o) => ({ id: o.id, sale_price: o.sale_price }))
      );
      return res.json({
        ok: true,
        count: offers.length,
        authUsed: candidate.label,
        messages: json.messages || [],
      });
    }

    console.error("[sync-prices] autentificare eMAG eșuată (401/403) — toate combo-urile");
    return res.status(lastStatus || 401).json({
      error: "Autentificare eMAG eșuată (401/403). Verifică credentials și IP whitelist.",
      messages: lastJson?.messages || [],
      detail: lastText.slice(0, 300),
    });
  } catch (err) {
    console.error("[sync-prices] exception:", err.message);
    return res.status(500).json({ error: err.message || "Eroare la sync prețuri" });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const creds = loadCredentials();
    const candidates = authCandidates(creds);
    console.log(
      `[auth:products] ordine încercări:`,
      candidates.map((c) => c.label).join(" → ")
    );

    let lastStatus = null;
    let lastJson = null;
    let lastText = "";

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      logAuthAttempt("products", candidate, i, candidates.length);
      const auth = authHeader(candidate.user, candidate.pass);
      const { response, json, text } = await emagProductOfferRead(auth, page);
      lastStatus = response.status;
      lastJson = json;
      lastText = text;

      if (response.status === 401 || response.status === 403) {
        logAuthResult("products", candidate, response.status, false);
        continue;
      }

      logAuthResult("products", candidate, response.status, true);
      savePreferredAuthLabel(candidate.label);

      if (!json) {
        return res.status(502).json({
          error: "Răspuns invalid de la eMAG",
          status: response.status,
          detail: text.slice(0, 500),
        });
      }

      if (json.isError) {
        return res.status(502).json({
          error: "eMAG a returnat eroare",
          messages: json.messages || [],
        });
      }

      const results = Array.isArray(json.results) ? json.results : [];
      const products = results.map(mapOffer);

      console.log(
        `[auth:products] OK page=${page} count=${products.length} auth=${candidate.label}`
      );
      return res.json({
        page,
        itemsPerPage: ITEMS_PER_PAGE,
        count: products.length,
        hasMore: products.length >= ITEMS_PER_PAGE,
        authUsed: candidate.label,
        products,
      });
    }

    console.error("[auth:products] autentificare eMAG eșuată (401/403) — toate combo-urile");
    return res.status(lastStatus || 401).json({
      error: "Autentificare eMAG eșuată (401/403). Verifică credentials și IP whitelist.",
      messages: lastJson?.messages || [],
      detail: lastText.slice(0, 300),
    });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare server" });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const createdAfter =
      typeof req.query.createdAfter === "string" && req.query.createdAfter.trim()
        ? req.query.createdAfter.trim()
        : null;
    const createdBefore =
      typeof req.query.createdBefore === "string" && req.query.createdBefore.trim()
        ? req.query.createdBefore.trim()
        : null;

    let status = null;
    if (req.query.status != null && req.query.status !== "") {
      const raw = Array.isArray(req.query.status)
        ? req.query.status
        : String(req.query.status).split(",");
      status = raw
        .map((s) => parseInt(String(s).trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 5);
      if (status.length === 0) status = null;
    }

    if (createdAfter && createdBefore) {
      const after = Date.parse(createdAfter.replace(" ", "T"));
      const before = Date.parse(createdBefore.replace(" ", "T"));
      if (Number.isFinite(after) && Number.isFinite(before)) {
        const maxMs = 31 * 24 * 60 * 60 * 1000;
        if (before < after) {
          return res.status(400).json({
            error: "createdBefore trebuie să fie după createdAfter",
          });
        }
        if (before - after > maxMs) {
          return res.status(400).json({
            error: "Intervalul de dată eMAG e max 1 lună",
          });
        }
      }
    }

    const creds = loadCredentials();
    const candidates = authCandidates(creds);
    console.log(
      `[auth:orders] ordine încercări:`,
      candidates.map((c) => c.label).join(" → ")
    );

    let lastStatus = null;
    let lastJson = null;
    let lastText = "";

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      logAuthAttempt("orders", candidate, i, candidates.length);
      const auth = authHeader(candidate.user, candidate.pass);
      const { response, json, text } = await emagOrderRead(auth, {
        page,
        status,
        createdAfter,
        createdBefore,
      });
      lastStatus = response.status;
      lastJson = json;
      lastText = text;

      if (response.status === 401 || response.status === 403) {
        logAuthResult("orders", candidate, response.status, false);
        continue;
      }

      logAuthResult("orders", candidate, response.status, true);
      savePreferredAuthLabel(candidate.label);

      if (!json) {
        return res.status(502).json({
          error: "Răspuns invalid de la eMAG",
          status: response.status,
          detail: text.slice(0, 500),
        });
      }

      if (json.isError) {
        return res.status(502).json({
          error: "eMAG a returnat eroare",
          messages: json.messages || [],
        });
      }

      const results = Array.isArray(json.results) ? json.results : [];
      const orders = results.map(mapOrder);

      console.log(
        `[auth:orders] OK page=${page} count=${orders.length} auth=${candidate.label}`
      );
      return res.json({
        page,
        itemsPerPage: ITEMS_PER_PAGE,
        count: orders.length,
        hasMore: orders.length >= ITEMS_PER_PAGE,
        authUsed: candidate.label,
        orders,
      });
    }

    console.error("[auth:orders] autentificare eMAG eșuată (401/403) — toate combo-urile");
    return res.status(lastStatus || 401).json({
      error: "Autentificare eMAG eșuată (401/403). Verifică credentials și IP whitelist.",
      messages: lastJson?.messages || [],
      detail: lastText.slice(0, 300),
    });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare server" });
  }
});

app.listen(PORT, () => {
  console.log(`Server pornit: http://localhost:${PORT}`);
});
