const crypto = require("crypto");
const express = require("express");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");
const { getSettings, saveSettings, getPretEmagHistory, getOrderLinesForProduct } = require("./db");
const {
  normalizeChannel,
  clearChannelCache,
  getCatalogRows,
  updateListing,
  getListing,
  updateProduct,
  getProduct,
  getChannelStats,
  recalcPretCumparare,
  touchesPretCumparareInputs,
  ensureSchema,
} = require("./marketplace-db");
const { diffFields, summarizeChanges, productLabel } = require("./change-log");
const {
  MAX_BYTES,
  ALLOWED_MIME,
  ensureBucket,
  addImages,
  deleteImage,
  reorder: reorderImages,
  listAllForProduct,
  listByPlatformForProductIds,
  normalizePlatform,
  absoluteUrl,
  verifyImageSignature,
  getObjectStream,
} = require("./product-images");
const { getChannel, listChannels } = require("./channels");
const {
  log,
  queryLogs,
  getLogFacets,
  clearLogs,
  pruneLogs,
} = require("./logs-db");
const {
  publicCredentialsStatus,
  saveCredentialsPatch,
  getEmagCreds,
  getTrendyolCreds,
} = require("./credentials-store");
const { query } = require("./pg");
const baseClient = require("./base-client");
const basePush = require("./base-push");
const { startBaseSync } = require("./base-sync");
const baseCommission = require("./base-commission");
const { PLATFORMS: IMAGE_PLATFORMS } = require("./product-images");
const { attachCustomerReviews } = require("./emag-reviews");
const { getStats } = require("./stats");
const {
  isAuthEnabled,
  requireAppAuth,
  authStatusHandler,
  authLoginHandler,
  authLogoutHandler,
} = require("./app-auth");

const PORT = process.env.PORT || 3000;
const COMMISSION_FETCH_CONCURRENCY = 5;

const app = express();
// Exportul trimite tot tabelul intr-un singur POST - limita implicita de 100kb e prea mica.
app.use("/api/products/export", express.json({ limit: "25mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Parola de acces la aplicație (APP_PASSWORD). Cookie httpOnly, reținut ~1 an.
app.get("/api/auth/status", authStatusHandler);
app.post("/api/auth/login", authLoginHandler);
app.post("/api/auth/logout", authLogoutHandler);

/**
 * Poza cu link semnat — singura ruta de poze dinaintea login-ului, fiindca eMAG
 * descarca de aici pozele pe care i le trimitem. Fara `sig` corect, 404.
 * Restul aplicatiei foloseste /uploads/products/... (in spatele login-ului).
 */
app.get("/public/product-image/:storedName", async (req, res) => {
  try {
    const storedName = path.basename(String(req.params.storedName || ""));
    if (!storedName || !verifyImageSignature(storedName, req.query.sig)) {
      return res.status(404).end();
    }
    const obj = await getObjectStream(storedName);
    res.setHeader("Content-Type", obj.contentType);
    if (obj.contentLength != null) {
      res.setHeader("Content-Length", String(obj.contentLength));
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    obj.body.pipe(res);
  } catch (err) {
    const notFound = err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey";
    if (!notFound) {
      console.error("[public:image]", err.message);
      logCaught("product-images", err);
    }
    return res.status(404).end();
  }
});

// Panoul de apeluri este intenționat public: operatorul îl poate deschide fără parolă.
function firstValue(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "object") {
      const nested = value.name || value.code || value.value;
      if (nested != null && String(nested).trim() !== "") return nested;
      continue;
    }
    if (String(value).trim() !== "") return value;
  }
  return null;
}

function findNestedValue(value, keys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return null;
  for (const key of keys) {
    if (value[key] != null && String(value[key]).trim() !== "") return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findNestedValue(child, keys, depth + 1);
    if (found != null) return found;
  }
  return null;
}

function extractCustomerContact(raw) {
  const customer = Array.isArray(raw?.customer) ? raw.customer[0] : raw?.customer;
  const delivery = Array.isArray(raw?.delivery) ? raw.delivery[0] : raw?.delivery;
  const address = customer?.address || customer?.shipping_address || delivery?.address || delivery;
  const phoneCandidates = [
    customer?.phone_1,
    customer?.phone,
    customer?.shipping_phone,
    customer?.billing_phone,
    customer?.phone_2,
    customer?.phone_3,
    customer?.telephone,
    customer?.mobile,
    customer?.phone_number,
    address?.phone,
    address?.telephone,
    findNestedValue(raw, ["phone", "telephone", "mobile", "phone_number"])
  ];
  const phones = [];
  const seenPhones = new Set();
  for (const candidate of phoneCandidates) {
    const value = firstValue(candidate);
    if (!value) continue;
    const display = String(value).trim();
    const key = display.replace(/[^\d+]/g, "");
    if (!key || seenPhones.has(key)) continue;
    seenPhones.add(key);
    phones.push(display);
  }
  const phone = phones[0] || null;
  const countryCode = firstValue(
    customer?.shipping_country,
    customer?.billing_country,
    address?.country_code,
    address?.countryCode,
    address?.country?.code,
    address?.shipping_country,
    address?.billing_country,
    customer?.country_code,
    customer?.countryCode,
    delivery?.country_code,
    delivery?.country
  );
  const country = firstValue(
    address?.country,
    address?.country_name,
    address?.countryName,
    customer?.country,
    customer?.country_name,
    customer?.shipping_country,
    customer?.billing_country,
    findNestedValue(raw, ["country_code", "countryCode", "country_name", "country", "shipping_country", "billing_country"])
  );
  const city = firstValue(address?.city, address?.locality, address?.town);
  const normalizedCountry = String(countryCode || country || "").trim().toLowerCase();
  const isRomania =
    ["ro", "rou", "romania", "românia"].includes(normalizedCountry) ||
    /român|roman/i.test(normalizedCountry);
  return {
    phone,
    phones,
    country: country ? String(country).trim() : countryCode ? String(countryCode).trim() : null,
    country_code: countryCode ? String(countryCode).trim() : null,
    city: city ? String(city).trim() : null,
    is_romania: isRomania,
  };
}

function emagSlug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function rawProductForLine(raw, line) {
  const products = Array.isArray(raw?.products) ? raw.products : [];
  const part = String(line.part_number || "").trim();
  const pnk = String(line.review_part_number || "").trim();
  return products.find((product) => {
    const productPnk = String(product?.part_number_key || "").trim();
    const productPart = String(product?.part_number || product?.ext_part_number || "").trim();
    return (pnk && productPnk === pnk) || (part && (productPart === part || productPnk === part));
  }) || null;
}

function reviewUrlFor(partNumber, productName) {
  const value = String(partNumber || "").trim();
  if (!value) return null;
  const slug = emagSlug(productName) || "produs";
  const path = `${slug}/pd/${encodeURIComponent(value)}`;
  return `https://www.emag.ro/${path}/?path=${path}#reviews-section`;
}

const REVIEW_COOKIE = "review_calls_access";

function reviewPassword() {
  return String(process.env.REVIEW_CALLS_PASSWORD || "").trim();
}

const REVIEW_SESSION_SECONDS = 365 * 24 * 60 * 60;

function reviewSessionToken() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + REVIEW_SESSION_SECONDS * 1000 }),
    "utf8"
  ).toString("base64url");
  const secret = String(
    process.env.APP_SESSION_SECRET || process.env.CREDENTIALS_ENCRYPTION_KEY || "emag-review-session"
  );
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function reviewCookieToken(req) {
  const raw = String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REVIEW_COOKIE}=`));
  return raw ? decodeURIComponent(raw.slice(REVIEW_COOKIE.length + 1)) : "";
}

function reviewBearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function reviewTokenValid(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return false;
  const secret = String(
    process.env.APP_SESSION_SECRET || process.env.CREDENTIALS_ENCRYPTION_KEY || "emag-review-session"
  );
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    return Number(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp) > Date.now();
  } catch {
    return false;
  }
}

function reviewSessionValid(req) {
  return reviewTokenValid(reviewBearerToken(req)) || reviewTokenValid(reviewCookieToken(req));
}

function reviewRequestIsSecure(req) {
  if (req.secure) return true;
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return proto === "https";
}

function reviewCookieHeader(req, token = "") {
  const maxAge = token ? REVIEW_SESSION_SECONDS : 0;
  return `${REVIEW_COOKIE}=${token ? encodeURIComponent(token) : ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${reviewRequestIsSecure(req) ? "; Secure" : ""}`;
}

app.post("/api/review-calls/auth", (req, res) => {
  const provided = String(req.body?.password || "");
  const expected = reviewPassword();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const valid =
    a.length === b.length && expected.length > 0 && crypto.timingSafeEqual(a, b);
  const formPost = req.is("application/x-www-form-urlencoded");
  if (!valid) {
    if (formPost) return res.redirect(303, "/apeluri.html?login=eroare");
    return res.status(401).json({ error: "Parolă greșită" });
  }
  const token = reviewSessionToken();
  res.setHeader("Set-Cookie", reviewCookieHeader(req, token));
  if (formPost) return res.redirect(303, "/apeluri.html");
  return res.json({ ok: true, token });
});

app.post("/api/review-calls/logout", (req, res) => {
  res.setHeader("Set-Cookie", reviewCookieHeader(req));
  return res.json({ ok: true });
});

function requireReviewAuth(req, res, next) {
  if (reviewSessionValid(req)) return next();
  return res.status(401).json({ error: "Autentificare necesară", code: "REVIEW_AUTH_REQUIRED" });
}

app.get("/api/review-calls", requireReviewAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 5000, 1), 10000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { rows: orders } = await query(
      `SELECT order_id, channel, status, order_date, customer_name, currency, products_total, raw,
              EXISTS (
                SELECT 1 FROM review_call_state s
                WHERE s.order_id = e.order_id AND s.called = TRUE
              ) AS called
       FROM emag_orders e
       WHERE e.platform = 'ro'
       ORDER BY order_date DESC NULLS LAST, order_id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const orderIds = orders.map((order) => order.order_id);
    const { rows: lines } = orderIds.length
      ? await query(
          `SELECT l.order_id, l.line_id, l.catalog_product_id, l.part_number, l.name,
                  l.quantity, l.sale_price, l.status, l.currency,
                  COALESCE(c.part_number_key, c.part_number, l.part_number) AS review_part_number,
                  COALESCE(
                    (SELECT pi.source_url FROM product_images pi
                     WHERE pi.product_id = l.catalog_product_id
                       AND pi.platform IN ('ro', 'en')
                     ORDER BY CASE WHEN pi.platform = 'ro' THEN 0 ELSE 1 END,
                              pi.sort_order, pi.id
                     LIMIT 1),
                    ''
                  ) AS image_url,
                  (SELECT pi.stored_name FROM product_images pi
                   WHERE pi.product_id = l.catalog_product_id
                   ORDER BY CASE WHEN pi.platform = 'ro' THEN 0 ELSE 1 END,
                            pi.sort_order, pi.id
                   LIMIT 1) AS image_stored_name
           FROM order_line_history l
           LEFT JOIN catalog_products c ON c.id = l.catalog_product_id
           WHERE l.order_id = ANY($1::bigint[])
           ORDER BY l.order_id DESC, l.line_id`,
          [orderIds]
        )
      : { rows: [] };
    const rawByOrder = new Map(orders.map((order) => [String(order.order_id), order.raw || {}]));
    const linesByOrder = new Map();
    for (const line of lines) {
      const key = String(line.order_id);
      if (!linesByOrder.has(key)) linesByOrder.set(key, []);
      const rawProduct = rawProductForLine(rawByOrder.get(key), line);
      const pnk = String(rawProduct?.part_number_key || line.review_part_number || "").trim();
      linesByOrder.get(key).push({
        line_id: line.line_id,
        catalog_product_id: line.catalog_product_id,
        part_number: line.part_number,
        review_part_number: line.review_part_number || line.part_number,
        pnk: /^[A-Z0-9]{6,20}$/i.test(pnk) ? pnk : "",
        mkt_id: rawProduct?.mkt_id ?? null,
        name: line.name,
        quantity: line.quantity,
        sale_price: line.sale_price,
        status: line.status,
        currency: line.currency || "RON",
        image_url: line.image_url || (line.image_stored_name
          ? (() => {
              try {
                return absoluteUrl(line.image_stored_name);
              } catch {
                return null;
              }
            })()
          : null),
        review_url: reviewUrlFor(
          line.review_part_number || line.part_number,
          line.name
        ),
        customer_reviews: [],
      });
    }
    const payload = orders.map((order) => ({
      id: order.order_id,
      channel: order.channel || "emag",
      status: order.status,
      date: order.order_date,
      customer_name: order.customer_name,
      currency: order.currency || "RON",
      products_total: order.products_total,
      called: Boolean(order.called),
      contact: extractCustomerContact(order.raw || {}),
      products: linesByOrder.get(String(order.order_id)) || [],
      customer_reviews: [],
    }));
    let reviewsNote = "";
    try {
      const reviewResult = await attachCustomerReviews(payload);
      reviewsNote = reviewResult.note || "";
    } catch (err) {
      console.error("[review-calls:reviews]", err.message);
      reviewsNote = "Review-urile nu au putut fi încărcate.";
    }
    return res.json({
      orders: payload,
      count: payload.length,
      hasMore: orders.length === limit,
      offset,
      reviews_note: reviewsNote,
    });
  } catch (err) {
    console.error("[review-calls:list]", err.message);
    return res.status(500).json({ error: err.message || "Eroare la încărcarea apelurilor" });
  }
});

app.patch("/api/review-calls/:orderId", requireReviewAuth, async (req, res) => {
  try {
    const orderId = String(req.params.orderId || "").trim();
    if (!/^\d+$/.test(orderId)) return res.status(400).json({ error: "ID comandă invalid" });
    const called = Boolean(req.body?.called);
    const { rows } = await query(
      `INSERT INTO review_call_state (order_id, called, called_at, updated_at)
       VALUES ($1, $2, CASE WHEN $2 THEN now() ELSE NULL END, now())
       ON CONFLICT (order_id) DO UPDATE SET
         called = EXCLUDED.called,
         called_at = EXCLUDED.called_at,
         updated_at = now()
       RETURNING order_id, called, called_at`,
      [orderId, called]
    );
    return res.json({ ok: true, ...rows[0] });
  } catch (err) {
    console.error("[review-calls:update]", err.message);
    return res.status(500).json({ error: err.message || "Eroare la salvarea bifei" });
  }
});

app.use(requireAppAuth);

const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 20 },
  fileFilter(_req, file, cb) {
    const mime = String(file.mimetype || "").toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      return cb(new Error(`Tip fisier neacceptat: ${mime || "unknown"}`));
    }
    cb(null, true);
  },
});

/** Categoria de log derivata din calea API, pentru filtrarea din /logs.html. */
function categoryForPath(urlPath) {
  const p = urlPath.split("?")[0];
  if (p.startsWith("/api/products/fetch-commission")) return "commission";
  if (p.startsWith("/api/products/export")) return "export";
  if (p.includes("/history")) return "history";
  if (p.startsWith("/api/catalog/product") && p.includes("/images")) return "product-images";
  if (p.startsWith("/api/catalog/listing")) return "listing-patch";
  if (p.startsWith("/api/catalog/product")) return "product-patch";
  if (p.startsWith("/api/settings")) return "settings";
  if (p.startsWith("/api/stats")) return "stats";
  if (p.startsWith("/api/base")) return "base";
  if (p.startsWith("/api/credentials")) return "credentials";
  return "http";
}

// Logheaza fiecare apel /api/*, mai putin rutele paginii de logs (altfel se auto-logheaza in bucla).
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/") || req.path.startsWith("/api/logs") || req.path === "/api/health") return next();
  const startedAt = Date.now();
  res.on("finish", () => {
    // Rutele de salvare pun in res.locals.changeLog ce campuri au schimbat (vezi noteChanges).
    const changeLog = res.statusCode < 400 ? res.locals.changeLog : null;
    void log({
      level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      source: "server",
      category: categoryForPath(req.path),
      message: changeLog?.message || `${req.method} ${req.originalUrl} → ${res.statusCode}`,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      detail: {
        method: req.method,
        path: req.path,
        query: req.query,
        bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body) : [],
        ...changeLog?.detail,
      },
    });
  });
  next();
});

/** Alias-urile din body-ul de salvare → coloana din catalog_products. */
const FIELD_COLUMN_ALIASES = { name: "nume", description: "descriere", stock: "general_stock" };

/** Coloanele pe care le poate schimba o salvare cu `fields`, inclusiv efectele secundare. */
function columnsTouchedBy(fields) {
  const cols = new Set(Object.keys(fields || {}).map((k) => FIELD_COLUMN_ALIASES[k] || k));
  if (touchesPretCumparareInputs(fields)) cols.add("pret_cumparare");
  if (cols.has("id_familie")) cols.add("familie");
  return cols;
}

/** Campurile schimbate de o salvare ajung in mesajul si detaliile logului HTTP al cererii. */
function noteChanges(res, { subject, changes, sent, note, extra }) {
  res.locals.changeLog = {
    message: `${subject}: ${summarizeChanges(changes)}${note ? ` (${note})` : ""}`,
    detail: { changes, ...(sent ? { sent } : {}), ...extra },
  };
}

// Health check pentru containerul back (nu atinge DB/S3).
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/** Proxy poze din MinIO/S3 — UI păstrează URL-uri relative /uploads/products/... */
app.get("/uploads/products/:storedName", async (req, res) => {
  try {
    const storedName = path.basename(String(req.params.storedName || ""));
    if (!storedName) return res.status(400).end();
    const obj = await getObjectStream(storedName);
    res.setHeader("Content-Type", obj.contentType);
    if (obj.contentLength != null) {
      res.setHeader("Content-Length", String(obj.contentLength));
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    obj.body.pipe(res);
  } catch (err) {
    const notFound = err?.$metadata?.httpStatusCode === 404 || err?.name === "NoSuchKey";
    if (!notFound) {
      console.error("[uploads:proxy]", err.message);
      logCaught("product-images", err);
    }
    return res.status(404).end();
  }
});

function httpStatusFor(err) {
  const s = Number(err?.status);
  if (Number.isFinite(s) && s >= 400 && s <= 599) return s;
  return 502;
}

/** Log de eroare cu stack, pentru catch-urile care nu trec prin sendChannelError. */
function logCaught(category, err, extra) {
  void log({
    level: "error",
    source: "server",
    category,
    message: err?.message || "Eroare necunoscuta",
    detail: { stack: err?.stack, ...extra },
  });
}

function sendChannelError(res, err, fallback) {
  const status = httpStatusFor(err);
  void log({
    level: "error",
    source: "server",
    category: "channel-error",
    message: err?.message || fallback,
    status,
    detail: { stack: err?.stack, messages: err?.messages, detail: err?.detail, code: err?.code },
  });
  const body = {
    error: err?.message || fallback,
    messages: err?.messages || [],
    detail: err?.detail || undefined,
  };
  if (err?.code) body.code = err.code;
  if (err?.settingsPath) body.settingsPath = err.settingsPath;
  return res.status(status).json(body);
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

/* ---------------- setari ---------------- */

// Formulele calculatorului, aceleasi in browser (window.Calculator) si pe server.
app.get("/api/calculator.js", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.type("application/javascript");
  return res.sendFile(path.join(__dirname, "calculator.js"));
});

app.get("/api/settings", async (_req, res) => {
  try {
    return res.json(await getSettings());
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la citire setări" });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const toNum = (v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const before = await getSettings().catch(() => null);
    // Fiecare pagina trimite doar ce editeaza (multiplicatorii vin din Setari, restul din Produse).
    const body = req.body || {};
    const pick = (key) => (Object.prototype.hasOwnProperty.call(body, key) ? toNum(body[key]) : before?.[key] ?? null);
    const saved = await saveSettings({
      procentaj_alte_costuri: pick("procentaj_alte_costuri"),
      mult_prp: pick("mult_prp"),
      mult_min: pick("mult_min"),
      mult_max: pick("mult_max"),
      calculator_params:
        req.body?.calculator_params && typeof req.body.calculator_params === "object"
          ? req.body.calculator_params
          : undefined,
    });
    // Parametrii calculatorului schimba costul final → pret_cumparare pe tot catalogul.
    let recalculated = null;
    if (saved.calculator_params && req.body?.calculator_params) {
      recalculated = await recalcPretCumparare(null);
    }
    noteChanges(res, {
      subject: "Setări",
      changes: diffFields(before, saved),
      note: recalculated ? `pret_cumparare recalculat la ${recalculated} produse` : null,
    });

    return res.json(saved);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la salvare setări" });
  }
});

/* ---------------- credentiale marketplace ---------------- */

app.get("/api/credentials", async (_req, res) => {
  try {
    return res.json(await publicCredentialsStatus());
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la citire credentiale" });
  }
});

app.post("/api/credentials", async (req, res) => {
  try {
    const body = req.body || {};
    const hasEmag = body.emag && typeof body.emag === "object";
    const hasTrendyol = body.trendyol && typeof body.trendyol === "object";
    if (!hasEmag && !hasTrendyol) {
      return res.status(400).json({ error: "Trimite secțiunea emag și/sau trendyol" });
    }

    if (hasEmag) {
      const email = String(body.emag.email ?? body.emag.USER_EMAIL ?? "").trim();
      const password = String(body.emag.password ?? body.emag.ACCOUNT_PASSWORD ?? "").trim();
      const prev = await getEmagCreds();
      const nextEmail = email || prev.USER_EMAIL;
      const nextPassword = password || prev.ACCOUNT_PASSWORD;
      if (!nextEmail || !nextPassword) {
        return res.status(400).json({
          error: "eMAG necesită email și parolă",
          code: "CREDENTIALS_MISSING",
          settingsPath: "/settings.html#emag",
        });
      }
    }

    if (hasTrendyol) {
      const prev = await getTrendyolCreds();
      const supplierId = String(
        body.trendyol.supplierId ?? body.trendyol.SUPPLIER_ID ?? ""
      ).trim();
      const apiKey = String(body.trendyol.apiKey ?? body.trendyol.API_KEY ?? "").trim();
      const apiSecret = String(
        body.trendyol.apiSecret ?? body.trendyol.API_SECRET ?? ""
      ).trim();
      const next = {
        SUPPLIER_ID: supplierId || prev.SUPPLIER_ID,
        API_KEY: apiKey || prev.API_KEY,
        API_SECRET: apiSecret || prev.API_SECRET,
      };
      if (!next.SUPPLIER_ID || !next.API_KEY || !next.API_SECRET) {
        return res.status(400).json({
          error: "Trendyol necesită Supplier ID, API Key și API Secret",
          code: "CREDENTIALS_MISSING",
          settingsPath: "/settings.html#trendyol",
        });
      }
    }

    await saveCredentialsPatch({
      emag: hasEmag ? body.emag : undefined,
      trendyol: hasTrendyol ? body.trendyol : undefined,
    });
    // Credentiale eMAG schimbate → invalideaza oglinda remote din memorie.
    if (hasEmag) clearChannelCache("emag");
    return res.json(await publicCredentialsStatus());
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la salvare credentiale" });
  }
});

/* ---------------- catalog local (sursa tabelului principal) ---------------- */

app.get("/api/channels", async (_req, res) => {
  try {
    const listed = await listChannels();
    const channels = await Promise.all(
      listed.map(async (c) => ({
        ...c,
        ...(await getChannelStats(c.id)),
      }))
    );
    return res.json({ channels });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la citire canale" });
  }
});

app.get("/api/catalog", async (req, res) => {
  try {
    const channel = normalizeChannel(req.query.channel);
    const products = await getCatalogRows(channel);
    const stats = await getChannelStats(channel);
    res.set("Cache-Control", "no-store");
    return res.json({
      channel,
      count: products.length,
      last_sync: stats.last_sync,
      products,
    });
  } catch (err) {
    console.error("[catalog]", err.message);
    logCaught("catalog", err);
    return res.status(500).json({ error: err.message || "Eroare la citire catalog" });
  }
});

// Alias: tabel = DB local brut (catalog_products), fara gate de cache.
app.get("/api/products", async (req, res) => {
  try {
    const channel = normalizeChannel(req.query.channel);
    const products = await getCatalogRows(channel);
    const stats = await getChannelStats(channel);
    res.set("Cache-Control", "no-store");
    return res.json({
      page: 1,
      itemsPerPage: products.length,
      count: products.length,
      hasMore: false,
      last_sync: stats.last_sync,
      products,
    });
  } catch (err) {
    console.error("[products]", err.message);
    logCaught("products", err);
    return res.status(500).json({ error: err.message || "Eroare la citire produse" });
  }
});

app.patch("/api/catalog/listing/:externalId", async (req, res) => {
  try {
    const channel = normalizeChannel(req.query.channel ?? req.body?.channel);
    const externalId = String(req.params.externalId || "").trim();
    if (!externalId) {
      return res.status(400).json({ error: "external_id invalid" });
    }
    const fields = req.body?.fields && typeof req.body.fields === "object"
      ? req.body.fields
      : req.body || {};
    const before = await getListing(channel, externalId).catch(() => null);
    const saved = await updateListing(channel, externalId, fields);
    noteChanges(res, {
      subject: `Produs ${productLabel(saved)} (${channel} ${externalId})`,
      changes: diffFields(before, saved, { only: columnsTouchedBy(fields) }),
      sent: Object.keys(fields),
    });
    return res.json({ ok: true, channel, listing: saved });
  } catch (err) {
    console.error("[listing:patch]", err.message);
    logCaught("listing-patch", err);
    return res.status(400).json({ error: err.message || "Eroare la salvare listing" });
  }
});

app.patch("/api/catalog/product/:productId", async (req, res) => {
  try {
    const fields = req.body?.fields && typeof req.body.fields === "object"
      ? req.body.fields
      : req.body || {};
    const before = await getProduct(req.params.productId).catch(() => null);
    const saved = await updateProduct(req.params.productId, fields);
    if (!saved) return res.status(404).json({ error: "Produs inexistent" });
    noteChanges(res, {
      subject: `Produs ${productLabel(saved)}`,
      changes: diffFields(before, saved, { only: columnsTouchedBy(fields) }),
      sent: Object.keys(fields),
    });
    return res.json({ ok: true, product: saved });
  } catch (err) {
    console.error("[product:patch]", err.message);
    logCaught("product-patch", err);
    return res.status(400).json({ error: err.message || "Eroare la salvare produs" });
  }
});

app.post(
  "/api/catalog/product/:productId/images",
  (req, res, next) => {
    uploadImages.array("images", 20)(req, res, (err) => {
      if (!err) return next();
      const status = err.code === "LIMIT_FILE_SIZE" ? 400 : 400;
      return res.status(status).json({ error: err.message || "Upload esuat" });
    });
  },
  async (req, res) => {
    try {
      const platform = normalizePlatform(req.query.platform ?? req.body?.platform);
      const images = await addImages(req.params.productId, req.files || [], platform);
      return res.json({
        ok: true,
        platform,
        images,
        all: await listAllForProduct(req.params.productId),
      });
    } catch (err) {
      console.error("[product:images:post]", err.message);
      logCaught("product-images", err);
      const status = Number(err.status) || 400;
      return res.status(status).json({ error: err.message || "Eroare la upload poze" });
    }
  }
);

app.delete("/api/catalog/product/:productId/images/:imageId", async (req, res) => {
  try {
    await deleteImage(req.params.productId, req.params.imageId);
    return res.json({
      ok: true,
      all: await listAllForProduct(req.params.productId),
    });
  } catch (err) {
    console.error("[product:images:delete]", err.message);
    logCaught("product-images", err);
    const status = Number(err.status) || 400;
    return res.status(status).json({ error: err.message || "Eroare la stergere poza" });
  }
});

app.patch("/api/catalog/product/:productId/images/order", async (req, res) => {
  try {
    const platform = normalizePlatform(req.query.platform ?? req.body?.platform);
    const imageIds = req.body?.image_ids;
    const images = await reorderImages(req.params.productId, imageIds, platform);
    return res.json({
      ok: true,
      platform,
      images,
      all: await listAllForProduct(req.params.productId),
    });
  } catch (err) {
    console.error("[product:images:order]", err.message);
    logCaught("product-images", err);
    const status = Number(err.status) || 400;
    return res.status(status).json({ error: err.message || "Eroare la reordonare poze" });
  }
});

/* ---------------- Base (BaseLinker): tot ce pleaca din aplicatie ---------------- */

app.get("/api/base/status", async (_req, res) => {
  if (!baseClient.isConfigured()) {
    return res.json({ configured: false, send_enabled: baseClient.sendEnabled() });
  }
  try {
    return res.json({ configured: true, ...(await baseClient.getStatus()) });
  } catch (err) {
    return res.status(502).json({ configured: true, error: err.message });
  }
});

/** Lista pentru pagina „Pregătire Base”: ce poze/texte are fiecare produs si starea in Base. */
app.get("/api/base/products", async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.cod_produs, c.nume, c.ean, c.part_number_key, c.emag_offer_id, c.sale_price, c.general_stock,
              b.base_product_id, b.last_pushed_at, b.last_push_fingerprint,
              COALESCE(json_object_agg(t.lang, (COALESCE(t.name, '') <> '' AND COALESCE(t.description, '') <> ''))
                FILTER (WHERE t.lang IS NOT NULL), '{}') AS texts
       FROM catalog_products c
       LEFT JOIN base_products b ON b.product_id = c.id
       LEFT JOIN product_texts t ON t.product_id = c.id
       GROUP BY c.id, b.product_id
       ORDER BY c.id`
    );
    const images = await listByPlatformForProductIds(rows.map((r) => r.id));
    const products = rows.map((r) => {
      const byPlatform = images.get(Number(r.id)) || {};
      return {
        ...r,
        images: Object.fromEntries(IMAGE_PLATFORMS.map((p) => [p, (byPlatform[p] || []).length])),
        thumb: (byPlatform.ro?.[0] || byPlatform.en?.[0])?.url || null,
      };
    });
    return res.json({ products });
  } catch (err) {
    logCaught("base-products", err);
    return res.status(500).json({ error: err.message });
  }
});

/** Tot ce trebuie verificat inainte de trimitere: produsul, textele, pozele pe limbi, payload-ul Base. */
app.get("/api/base/product/:productId", async (req, res) => {
  try {
    const product = await getProduct(req.params.productId);
    if (!product) return res.status(404).json({ error: "Produs inexistent" });
    const [texts, images, preview, trendyolPct] = await Promise.all([
      basePush.getTexts(product.id),
      listByPlatformForProductIds([product.id]),
      basePush.buildPayload(product.id),
      baseCommission.getTrendyolPct(product.id),
    ]);
    return res.json({
      product,
      texts,
      images: images.get(Number(product.id)) || {},
      // Din comenzile Trendyol din Base („Comisioane din Base”); null = ca eMAG.
      trendyol_commission_pct: trendyolPct,
      preview,
    });
  } catch (err) {
    if (!err?.expected) logCaught("base-product", err);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

app.put("/api/base/product/:productId/texts/:lang", async (req, res) => {
  try {
    const b = req.body || {};
    const texts = await basePush.saveTexts(req.params.productId, String(req.params.lang).toLowerCase(), {
      name: b.name,
      description: b.description,
      characteristics: b.characteristics ?? null,
    });
    return res.json({ ok: true, texts });
  } catch (err) {
    if (!err?.expected) logCaught("base-texts", err);
    return res.status(err.status || 400).json({ error: err.message });
  }
});

/** Comisionul real eMAG RO si Trendyol, din comenzile din Base (doar citire). */
app.post("/api/base/commissions/refresh", async (_req, res) => {
  try {
    const result = await baseCommission.refreshCommissions();
    return res.json({ ok: true, ...result });
  } catch (err) {
    if (!err?.expected) logCaught("base-commission", err);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

/** Trimite produsul in Base; fara BASE_SEND=1 raspunde doar cu payload-ul (dry_run). */
app.post("/api/base/product/:productId/push", async (req, res) => {
  try {
    const result = await basePush.pushProductToBase(req.params.productId);
    return res.json({ ok: true, ...result });
  } catch (err) {
    if (!err?.expected) logCaught("base-push", err);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

/* ---------------- comision ---------------- */

app.post("/api/products/fetch-commission", async (req, res) => {
  const channelName = normalizeChannel(req.query.channel ?? req.body?.channel);
  try {
    const channel = getChannel(channelName);

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const normalized = items
      .map((item) => ({
        id: String(item?.id ?? "").trim(),
        sale_price: Number(item?.sale_price),
      }))
      .filter((item) => item.id);

    if (normalized.length === 0) {
      return res.status(400).json({ error: "items lipsă" });
    }

    const auth = await channel.resolveCommissionAuth(normalized[0].id);

    const fetched = await mapPool(normalized, COMMISSION_FETCH_CONCURRENCY, async (item) => {
      if (!Number.isFinite(item.sale_price) || item.sale_price <= 0) {
        return { id: item.id, error: "sale_price invalid — reîncarcă produsele" };
      }
      try {
        const { procentaj_emag, commission_value } = await channel.fetchCommission(
          auth,
          item.id,
          item.sale_price
        );
        const fetched_at = new Date().toISOString();
        await updateListing(channelName, item.id, {
          procentaj_emag,
          commission_value,
          commission_fetched_at: fetched_at,
        });
        return { id: item.id, procentaj_emag, commission_value, fetched_at };
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
    logCaught("commission", err);
    return sendChannelError(res, err, "Eroare la preluare comision");
  }
});

// Statistici (doar citire): vanzari, profit estimat, stoc, retururi, efectul preturilor.
app.get("/api/stats", async (req, res) => {
  try {
    return res.json(
      await getStats({ from: req.query.from, to: req.query.to, platform: req.query.platform })
    );
  } catch (err) {
    console.error("[stats]", err.message);
    return res.status(500).json({ error: err.message || "Eroare la statistici" });
  }
});

/* ---------------- istoric + export ---------------- */

app.get("/api/products/:offerId/history", async (req, res) => {
  try {
    const offerId = Number(req.params.offerId);
    if (!Number.isFinite(offerId)) {
      return res.status(400).json({ error: "offerId invalid" });
    }
    const channel = String(req.query.channel || "emag");
    return res.json({
      offer_id: offerId,
      channel,
      price_history: await getPretEmagHistory(offerId, channel),
      orders: await getOrderLinesForProduct(offerId),
    });
  } catch (err) {
    console.error("[history] exception:", err.message);
    logCaught("history", err);
    return res.status(500).json({ error: err.message || "Eroare istoric" });
  }
});

app.post("/api/products/export", (req, res) => {
  try {
    const headers = Array.isArray(req.body?.headers) ? req.body.headers : null;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!headers || headers.length === 0 || !rows) {
      return res.status(400).json({ error: "Date invalide pentru export" });
    }
    if (rows.length > 20000) {
      return res.status(400).json({ error: "Prea multe randuri pentru export" });
    }

    const aoa = [headers, ...rows.map((r) => (Array.isArray(r) ? r : []))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = headers.map((h) => ({
      wch: Math.min(Math.max(String(h).length + 4, 12), 45),
    }));
    ws["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: aoa.length - 1, c: headers.length - 1 },
      }),
    };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Produse");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="produse-${stamp}.xlsx"`
    );
    return res.send(buf);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la generare Excel" });
  }
});

/* ---------------- logs (pagina de debug) ---------------- */

app.get("/api/logs", async (req, res) => {
  try {
    const levels = String(req.query.level || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return res.json(
      await queryLogs({
        level: levels,
        source: req.query.source || undefined,
        category: req.query.category || undefined,
        q: req.query.q || undefined,
        from: req.query.from || undefined,
        to: req.query.to || undefined,
        limit: req.query.limit,
        offset: req.query.offset,
      })
    );
  } catch (err) {
    return res.status(500).json({ error: err.message || "Eroare la citire loguri" });
  }
});

app.get("/api/logs/facets", async (req, res) => {
  try {
    return res.json(await getLogFacets());
  } catch (err) {
    return res.status(500).json({ error: err.message || "Eroare la citire filtre" });
  }
});

app.delete("/api/logs", async (req, res) => {
  try {
    return res.json({ ok: true, deleted: await clearLogs() });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Eroare la stergere loguri" });
  }
});

/** Primeste batch-uri de evenimente din browser (public/logger.js). */
app.post("/api/logs/client", (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 50) : [];
  for (const entry of entries) {
    void log({
      level: entry?.level,
      source: "client",
      category: entry?.category || "ui",
      message: entry?.message || "",
      durationMs: entry?.durationMs,
      status: entry?.status,
      detail: entry?.detail,
      ts: typeof entry?.ts === "string" ? entry.ts : null,
    });
  }
  return res.json({ ok: true, received: entries.length });
});

// Ultima plasa de siguranta: orice exceptie scapata din rute ajunge in log.
app.use((err, req, res, next) => {
  void log({
    level: "error",
    source: "server",
    category: "uncaught",
    message: err?.message || "Eroare necunoscuta",
    detail: { stack: err?.stack, path: req?.path, method: req?.method },
  });
  console.error("[uncaught]", err?.stack || err);
  if (res.headersSent) return next(err);
  return res.status(500).json({ error: err?.message || "Eroare interna" });
});

process.on("uncaughtException", (err) => {
  void log({
    level: "error",
    source: "server",
    category: "uncaught",
    message: `uncaughtException: ${err?.message}`,
    detail: { stack: err?.stack },
  });
  console.error("[uncaughtException]", err?.stack || err);
});

process.on("unhandledRejection", (reason) => {
  void log({
    level: "error",
    source: "server",
    category: "uncaught",
    message: `unhandledRejection: ${reason?.message || reason}`,
    detail: { stack: reason?.stack },
  });
  console.error("[unhandledRejection]", reason?.stack || reason);
});

async function start() {
  await ensureSchema();
  await ensureBucket();
  await pruneLogs(14);
  if (isAuthEnabled()) {
    console.log("[auth] APP_PASSWORD setat — accesul necesită autentificare");
  } else {
    console.warn(
      "[auth] APP_PASSWORD lipsește din .env — aplicația e deschisă fără parolă"
    );
  }
  app.listen(PORT, () => {
    console.log(`Server pornit: http://localhost:${PORT}`);
  });
  // Base tine comenzile si stocul; aplicatia doar le citeste, pentru profit si coloana Stoc.
  startBaseSync();
}

start().catch((err) => {
  console.error("Nu am putut porni serverul:", err);
  process.exit(1);
});
