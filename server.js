const express = require("express");
const fs = require("fs");
const https = require("https");
const path = require("path");
const {
  lookupPretCumparare,
  lookupAlteCosturi,
  saveAlteCosturi,
  clearAlteCosturi,
  getSettings,
  saveSettings,
} = require("./db");

const PORT = process.env.PORT || 3000;
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
  return {
    id: offer.id,
    name,
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
      procentaj_emag: toNum(req.body?.procentaj_emag),
      procentaj_alte_costuri: toNum(req.body?.procentaj_alte_costuri),
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
    return res.status(500).json({ error: err.message || "Eroare la salvare alte costuri" });
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
      const payload = {
        id,
        status,
        sale_price,
        vat_id,
        handling_time,
        stock,
      };
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

app.listen(PORT, () => {
  console.log(`Server pornit: http://localhost:${PORT}`);
});
