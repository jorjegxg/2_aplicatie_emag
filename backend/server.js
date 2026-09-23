const crypto = require("crypto");
const express = require("express");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");
const {
  getSettings,
  saveSettings,
  recordPretEmagIfChanged,
  getPretEmagHistory,
  upsertOrderLines,
  getOrderLinesForProduct,
} = require("./db");
const {
  normalizeChannel,
  setChannelRemotes,
  upsertChannelRemote,
  clearChannelCache,
  getCatalogRows,
  updateListing,
  getChannelRemotes,
  getChannelViewRows,
  updateProduct,
  getProductOfferId,
  getChannelDiff,
  getChannelStats,
  getListingCosts,
  lookupCatalogPretCumparare,
  recalcPretCumparare,
  ensureSchema,
} = require("./marketplace-db");
const {
  MAX_BYTES,
  ALLOWED_MIME,
  ensureBucket,
  addImages,
  deleteImage,
  reorder: reorderImages,
  listForProduct,
  listAllForProduct,
  effectiveImages,
  imagesStamp,
  markImagesPushed,
  getPushedFingerprints,
  listByPlatformForProductIds,
  pickEffective,
  PUBLIC_BASE_URL,
  normalizePlatform,
  absoluteUrl,
  verifyImageSignature,
  getObjectStream,
} = require("./product-images");
const { getChannel, listChannels } = require("./channels");
const { httpError, pushOffersForChannel } = require("./channel-push");
const {
  log,
  queryLogs,
  getLogFacets,
  clearLogs,
  pruneLogs,
} = require("./logs-db");
const { ITEMS_PER_PAGE, loadCredentials, authCandidates, authHeader, logAuthAttempt, logAuthResult, savePreferredAuthLabel, emagOrderRead } = require("./emag-client");
const {
  publicCredentialsStatus,
  saveCredentialsPatch,
  getEmagCreds,
  getTrendyolCreds,
} = require("./credentials-store");
const {
  processEmagOrderId,
  pollRecentEmagOrders,
  listLocalOrders,
  listNewLocalOrders,
  listStockMovements,
} = require("./stock-movements");
const { applyTrendyolPackage, pollRecentTrendyolOrders } = require("./trendyol-orders");
const {
  initPush,
  getPublicKey,
  saveSubscription,
  removeSubscription,
  sendTestPush,
} = require("./push-notifications");
const {
  isAuthEnabled,
  requireAppAuth,
  authStatusHandler,
  authLoginHandler,
  authLogoutHandler,
} = require("./app-auth");

const PORT = process.env.PORT || 3000;
const COMMISSION_FETCH_CONCURRENCY = 5;
const MAX_PULL_PAGES = 50;
const activePulls = new Set();

const app = express();
// Exportul trimite tot tabelul intr-un singur POST - limita implicita de 100kb e prea mica.
app.use("/api/products/export", express.json({ limit: "25mb" }));
app.use(express.json());

// Parola de acces la aplicație (APP_PASSWORD). Cookie httpOnly, reținut ~1 an.
app.get("/api/auth/status", authStatusHandler);
app.post("/api/auth/login", authLoginHandler);
app.post("/api/auth/logout", authLogoutHandler);

// Callback-uri eMAG (setate in contul eMAG > Setari): GET/POST ...?token=SECRET&order_id=123.
// Publice (eMAG nu are cookie), protejate prin EMAG_WEBHOOK_TOKEN.
function webhookTokenOk(provided, envName = "EMAG_WEBHOOK_TOKEN") {
  const expected = String(process.env[envName] || "").trim();
  if (!expected) return false;
  const a = crypto.createHash("sha256").update(String(provided || "")).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function callbackParam(req, ...keys) {
  for (const key of keys) {
    const v = req.query[key] ?? req.body?.[key];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

/** Recitim comanda: eMAG da statusul curent (anulata / returnata), stocul se ajusteaza idempotent. */
async function refreshEmagOrder(req, kind) {
  const orderId = callbackParam(req, "order_id");
  if (!orderId || !/^\d+$/.test(orderId)) {
    if (kind === "order" || kind === "order-cancel") throw new Error("order_id lipsa");
    return;
  }
  await processEmagOrderId(orderId, { via: `webhook:${kind}` });
}

/** Produs nou / documentatie aprobata: reimprospatam oferta in oglinda (doar daca oglinda e incarcata). */
async function refreshEmagOffer(req) {
  const offerId = callbackParam(req, "id", "product_id", "offer_id");
  if (!offerId || !getChannelRemotes("emag")) return;
  const result = await getChannel("emag").fetchListings({ filters: { id: offerId } });
  const remote = (result.listings || []).find((o) => String(o.id) === offerId);
  if (remote) upsertChannelRemote("emag", remote);
}

const EMAG_CALLBACKS = {
  order: refreshEmagOrder,
  "order-cancel": refreshEmagOrder,
  awb: refreshEmagOrder,
  return: refreshEmagOrder,
  product: refreshEmagOffer,
  documentation: refreshEmagOffer,
  courier: null,
};

function emagCallback(kind, action) {
  return (req, res) => {
    if (!webhookTokenOk(req.query.token)) {
      return res.status(403).json({ error: "Token invalid" });
    }
    const { token: _token, ...queryParams } = req.query;
    res.json({ ok: true });
    // Payload-ul complet in logs: pentru unele callback-uri eMAG nu documenteaza parametrii.
    void log({
      level: "info",
      source: "server",
      category: "webhook-emag",
      message: `Callback eMAG ${kind}`,
      detail: { kind, method: req.method, query: queryParams, body: req.body ?? null },
    });
    if (!action) return;
    action(req, kind).catch((err) => {
      console.error(`[webhook:emag:${kind}]`, err.message);
      void log({
        level: "error",
        source: "server",
        category: "webhook-emag",
        message: `Callback eMAG ${kind} esuat: ${err.message}`,
        detail: { kind, query: queryParams, stack: err.stack },
      });
    });
  };
}

for (const [kind, action] of Object.entries(EMAG_CALLBACKS)) {
  const handler = emagCallback(kind, action);
  app.get(`/api/webhooks/emag/${kind}`, handler);
  app.post(`/api/webhooks/emag/${kind}`, express.urlencoded({ extended: false }), handler);
}

// Webhook Trendyol: POST cu pachetul complet in body, header x-api-key = TRENDYOL_WEBHOOK_TOKEN.
// Inregistrare: node scripts/register-trendyol-webhook.js https://<domeniu>/api/webhooks/ty/order
app.post("/api/webhooks/ty/order", (req, res) => {
  if (!webhookTokenOk(req.get("x-api-key"), "TRENDYOL_WEBHOOK_TOKEN")) {
    return res.status(403).json({ error: "Token invalid" });
  }
  const pkg = req.body;
  if (!pkg || !pkg.orderNumber) {
    return res.status(400).json({ error: "orderNumber lipsa" });
  }
  res.json({ ok: true });
  applyTrendyolPackage(pkg, { via: "webhook" }).catch((err) => {
    console.error(`[webhook:trendyol] comanda ${pkg.orderNumber}:`, err.message);
    void log({
      level: "error",
      source: "server",
      category: "webhook-trendyol",
      message: `Webhook comanda Trendyol ${pkg.orderNumber} esuat: ${err.message}`,
      detail: { orderNumber: pkg.orderNumber, packageId: pkg.id, stack: err.stack },
    });
  });
});

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
  if (p.startsWith("/api/sync/pull")) return "sync-pull";
  if (p.startsWith("/api/sync/diff")) return "sync-diff";
  if (p.startsWith("/api/products/sync-prices")) return "sync-prices";
  if (p.startsWith("/api/products/fetch-commission")) return "commission";
  if (p.startsWith("/api/products/export")) return "export";
  if (p.includes("/history")) return "history";
  if (p.startsWith("/api/catalog/product") && p.includes("/images")) return "product-images";
  if (p.startsWith("/api/catalog/listing")) return "listing-patch";
  if (p.startsWith("/api/catalog/product")) return "product-patch";
  if (p.startsWith("/api/webhooks/emag")) return "webhook-emag";
  if (p.startsWith("/api/webhooks/ty")) return "webhook-trendyol";
  if (p.startsWith("/api/orders") || p.startsWith("/api/stock-movements")) return "orders";
  if (p.startsWith("/api/settings")) return "settings";
  if (p.startsWith("/api/credentials")) return "credentials";
  return "http";
}

// Logheaza fiecare apel /api/*, mai putin rutele paginii de logs (altfel se auto-logheaza in bucla).
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/") || req.path.startsWith("/api/logs") || req.path === "/api/health") return next();
  const startedAt = Date.now();
  res.on("finish", () => {
    void log({
      level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      source: "server",
      category: categoryForPath(req.path),
      message: `${req.method} ${req.originalUrl} → ${res.statusCode}`,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      detail: {
        method: req.method,
        path: req.path,
        query: req.query,
        bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body) : [],
      },
    });
  });
  next();
});

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

/* ---------------- comenzi (mapare) ---------------- */

async function mapOrderProduct(product) {
  const name = product.name || product.product_name || "";
  const part_number = product.part_number || "";
  const product_id = product.product_id ?? null;
  const costs = product_id != null ? await getListingCosts("emag", product_id) : null;
  return {
    id: product.id ?? null,
    product_id,
    name,
    part_number,
    quantity: product.quantity ?? null,
    sale_price: product.sale_price ?? null,
    status: product.status ?? null,
    currency: product.currency || "RON",
    pret_cumparare: await lookupCatalogPretCumparare(part_number, name),
    transport_override: costs?.transport_override ?? null,
    procentaj_emag: costs?.procentaj_emag ?? null,
    commission_value: costs?.commission_value ?? null,
    commission_fetched_at: costs?.commission_fetched_at ?? null,
  };
}

async function mapOrder(order) {
  const customerRaw = Array.isArray(order.customer)
    ? order.customer[0]
    : order.customer;
  const products = Array.isArray(order.products)
    ? await Promise.all(order.products.map(mapOrderProduct))
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

    const saved = await saveSettings({
      procentaj_alte_costuri: toNum(req.body?.procentaj_alte_costuri),
      mult_prp: toNum(req.body?.mult_prp),
      mult_min: toNum(req.body?.mult_min),
      mult_max: toNum(req.body?.mult_max),
      calculator_params:
        req.body?.calculator_params && typeof req.body.calculator_params === "object"
          ? req.body.calculator_params
          : undefined,
    });
    // Parametrii calculatorului schimba costul final → pret_cumparare pe tot catalogul.
    if (saved.calculator_params && req.body?.calculator_params) {
      await recalcPretCumparare(null);
    }

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
    const saved = await updateListing(channel, externalId, fields);
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
    const saved = await updateProduct(req.params.productId, fields);
    if (!saved) return res.status(404).json({ error: "Produs inexistent" });
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

/** Platformele eMAG pe care putem publica poze (EN e doar setul implicit din aplicatie). */
const IMAGE_PUSH_PLATFORMS = ["ro", "bg", "hu"];

/**
 * Trimite pozele unui produs pe eMAG. `platform=ro|bg|hu`, sau `all` pentru toate trei.
 * Fiecare platforma primeste setul ei de poze sau, daca nu are, setul EN.
 */
app.post("/api/catalog/product/:productId/images/push", async (req, res) => {
  const wanted = String(req.query.platform ?? req.body?.platform ?? "all").toLowerCase();
  try {
    const targets =
      wanted === "all" ? IMAGE_PUSH_PLATFORMS : [normalizePlatform(wanted)];
    if (targets.includes("en")) {
      return res.status(400).json({
        error: "EN nu e o platformă eMAG — alege ro, bg, hu sau all",
      });
    }

    const offerId = await getProductOfferId(req.params.productId);
    if (!offerId) {
      return res.status(400).json({
        error: "Produsul nu are emag_offer_id — leagă întâi oferta eMAG",
      });
    }

    const emag = getChannel("emag");
    const results = [];
    for (const platform of targets) {
      const effective = await effectiveImages(req.params.productId, platform);
      if (!effective.images.length) {
        results.push({ platform, ok: false, error: "Nicio poză de trimis" });
        continue;
      }
      try {
        const pushed = await emag.pushImages(platform, [
          {
            offerId,
            images: effective.images.map((img) => ({ url: absoluteUrl(img.stored_name) })),
          },
        ]);
        await markImagesPushed(req.params.productId, platform, imagesStamp(effective));
        results.push({
          platform,
          ok: true,
          source: effective.source,
          count: effective.images.length,
          messages: pushed.messages || [],
        });
      } catch (err) {
        if (!err?.expected) logCaught("product-images", err);
        results.push({ platform, ok: false, error: err.message });
      }
    }

    const anyOk = results.some((r) => r.ok);
    return res.status(anyOk ? 200 : 502).json({ ok: anyOk, pending: anyOk, results });
  } catch (err) {
    console.error("[product:images:push]", err.message);
    if (!err?.expected) logCaught("product-images", err);
    const status = Number(err.status) || 400;
    return res.status(status).json({ error: err.message || "Eroare la trimiterea pozelor" });
  }
});

/* ---------------- sincronizare cu canalul ---------------- */

app.get("/api/sync/diff", async (req, res) => {
  try {
    const channel = normalizeChannel(req.query.channel);
    return res.json(await getChannelDiff(channel));
  } catch (err) {
    console.error("[diff]", err.message);
    logCaught("sync-diff", err);
    return res.status(500).json({ error: err.message || "Eroare la comparare" });
  }
});

/** Ce e pe canal (din oglinda remote in memorie) + partea locala pentru costuri/marja. */
app.get("/api/sync/channel-view", async (req, res) => {
  try {
    const channel = normalizeChannel(req.query.channel);
    const data = await getChannelViewRows(channel);
    res.set("Cache-Control", "no-store");
    return res.json(data);
  } catch (err) {
    console.error("[channel-view]", err.message);
    logCaught("sync-channel-view", err);
    return res.status(500).json({ error: err.message || "Eroare la citirea ofertelor de pe canal" });
  }
});

function sendSyncError(res, err, fallback) {
  if (err?.expected) return res.status(err.status).json({ error: err.message });
  return sendChannelError(res, err, fallback);
}

/** Preia toate ofertele canalului in oglinda remote (catalogul local ramane neatins). */
async function pullChannel(channelName) {
  if (activePulls.has(channelName)) {
    throw httpError(
      409,
      `Sincronizarea pentru ${channelName} este deja în curs. Așteaptă finalizarea ei.`
    );
  }
  activePulls.add(channelName);
  try {
    const channel = getChannel(channelName);

    let page = 1;
    let total = 0;
    let authUsed = null;
    const remotes = [];

    while (page <= MAX_PULL_PAGES) {
      const result = await channel.fetchListings({ page });
      const listings = result.listings || [];
      authUsed = result.authUsed || authUsed;

      for (const remote of listings) {
        remotes.push(remote);
        try {
          await recordPretEmagIfChanged(remote.id, remote.sale_price, remote.currency, "sync-pull");
        } catch (histErr) {
          console.warn("[sync-pull] istoric pret:", histErr.message);
        }
      }

      total += listings.length;
      if (!result.hasMore || listings.length === 0) break;
      page += 1;
    }

    setChannelRemotes(channelName, remotes);

    const stats = await getChannelStats(channelName);
    console.log(
      `[sync-pull] ${channelName}: ${total} oferte în cache (fără scriere catalog)`
    );
    return { count: total, pages: page, authUsed, last_sync: stats.last_sync };
  } finally {
    activePulls.delete(channelName);
  }
}

/** Trage oferte: oglinda remote merge in cache; catalogul local ramane neatins. */
app.post("/api/sync/pull", async (req, res) => {
  const channelName = normalizeChannel(req.query.channel ?? req.body?.channel);
  try {
    const result = await pullChannel(channelName);
    return res.json({ ok: true, channel: channelName, cache_only: true, ...result });
  } catch (err) {
    console.error("[sync-pull]", err.message);
    if (!err?.expected) logCaught("sync-pull", err);
    return sendSyncError(res, err, "Eroare la preluare de la canal");
  }
});

/** Preia o singura oferta de pe canal si o actualizeaza in oglinda remote. */
app.post("/api/sync/pull-offer", async (req, res) => {
  const channelName = normalizeChannel(req.query.channel ?? req.body?.channel);
  const offerId = String(req.body?.id ?? "").trim();
  if (!offerId) {
    return res.status(400).json({ error: "Lipseste id-ul ofertei" });
  }
  try {
    const channel = getChannel(channelName);
    const result = await channel.fetchListings({ filters: { id: offerId } });
    const remote = (result.listings || []).find(
      (o) => String(o.id) === offerId
    );
    if (!remote) {
      return res
        .status(404)
        .json({ error: `Oferta ${offerId} nu a fost gasita pe canal` });
    }

    try {
      await recordPretEmagIfChanged(
        remote.id,
        remote.sale_price,
        remote.currency,
        "sync-pull-offer"
      );
    } catch (histErr) {
      console.warn("[sync-pull-offer] istoric pret:", histErr.message);
    }

    upsertChannelRemote(channelName, remote);
    console.log(`[sync-pull-offer] ${channelName}: oferta ${offerId} actualizata in cache`);
    return res.json({
      ok: true,
      channel: channelName,
      id: remote.id,
      cache_only: true,
      authUsed: result.authUsed || null,
    });
  } catch (err) {
    console.error("[sync-pull-offer]", err.message);
    logCaught("sync-pull-offer", err);
    return sendChannelError(res, err, "Eroare la preluarea ofertei de la canal");
  }
});

app.post("/api/products/sync-prices", async (req, res) => {
  const channelName = normalizeChannel(req.query.channel ?? req.body?.channel);
  try {
    const rawOffers = Array.isArray(req.body?.offers) ? req.body.offers : [];
    const result = await pushOffersForChannel(channelName, rawOffers, {
      includeContentAll: req.body?.includeContent === true,
    });
    return res.json({ ok: true, channel: channelName, pending: true, ...result });
  } catch (err) {
    console.error("[sync-prices]", err.message);
    if (!err?.expected) logCaught("sync-prices", err);
    return sendSyncError(res, err, "Eroare la sync prețuri");
  }
});

/** Flag-uri de publicare pentru un rand din diff (doar campurile care difera), sau null. */
function pushFlagsFromDiffRow(row) {
  const changed = new Set((row.fields || []).filter((f) => f.differs).map((f) => f.key));
  if (changed.size === 0) return null;
  return {
    id: row.external_id,
    includeName: changed.has("name"),
    includeDescription: changed.has("description"),
    includeSalePrice: changed.has("sale_price"),
    includeRecommendedPrice: changed.has("recommended_price"),
    includeMinSalePrice: changed.has("min_sale_price"),
    includeMaxSalePrice: changed.has("max_sale_price"),
    includeStock: changed.has("general_stock"),
    includeImages: changed.has("images"),
    product_id: row.product_id,
  };
}

/**
 * Pozele pe BG si HU: le trimitem separat de canalul eMAG RO, pentru produsele
 * la care setul efectiv difera de ce am trimis ultima data pe platforma aceea.
 * -> cate un rezultat { platform, count, ok, error? } pe platforma.
 */
async function pushImagesToSecondaryPlatforms(diffRows) {
  const emag = getChannel("emag");
  const rows = (diffRows || []).filter((r) => r.product_id && r.external_id);
  const out = [];
  // Fara URL public eMAG nu poate descarca pozele — sarim peste, fara sa raportam erori.
  if (!rows.length || !PUBLIC_BASE_URL) return out;

  const productIds = rows.map((r) => r.product_id);
  const imagesByProduct = await listByPlatformForProductIds(productIds);
  const pushed = await getPushedFingerprints(productIds);

  for (const platform of ["bg", "hu"]) {
    const entry = { platform, count: 0, ok: true };
    try {
      const items = [];
      const stamps = [];
      for (const row of rows) {
        const effective = pickEffective(imagesByProduct.get(Number(row.product_id)), platform);
        if (!effective.images.length) continue;
        const stamp = imagesStamp(effective);
        if (stamp === pushed.get(`${Number(row.product_id)}:${platform}`)) continue;
        items.push({
          offerId: row.external_id,
          images: effective.images.map((img) => ({ url: absoluteUrl(img.stored_name) })),
        });
        stamps.push({ productId: row.product_id, stamp });
      }
      if (items.length > 0) {
        const result = await emag.pushImages(platform, items);
        entry.count = result.count;
        entry.messages = result.messages || [];
        if (result.skipped?.length) entry.skipped = result.skipped;
        for (const s of stamps) {
          await markImagesPushed(s.productId, platform, s.stamp);
        }
      }
    } catch (err) {
      if (!err?.expected) logCaught("push-all", err);
      entry.ok = false;
      entry.error = err.message || `Eroare la trimiterea pozelor pe eMAG ${platform.toUpperCase()}`;
    }
    out.push(entry);
  }
  return out;
}

let pushAllRunning = false;

/** Publica toate modificarile pe toate canalele configurate (preia oglinda daca lipseste). */
app.post("/api/sync/push-all", async (req, res) => {
  if (pushAllRunning) {
    return res.status(409).json({ error: "Publicarea pe toate canalele este deja în curs." });
  }
  pushAllRunning = true;
  try {
    const channels = (await listChannels()).filter((c) => c.configured);
    const results = [];
    for (const ch of channels) {
      const entry = { channel: ch.id, label: ch.label, pulled: false, count: 0, ok: true };
      try {
        if (!getChannelRemotes(ch.id)) {
          await pullChannel(ch.id);
          entry.pulled = true;
        }
        const diff = await getChannelDiff(ch.id);
        const offers = (diff.matched || []).map(pushFlagsFromDiffRow).filter(Boolean);
        if (offers.length > 0) {
          const result = await pushOffersForChannel(ch.id, offers);
          entry.count = offers.length;
          entry.messages = result?.messages || [];
        }
        console.log(`[push-all] ${ch.id}: ${entry.count} oferte trimise${entry.pulled ? " (după preluare)" : ""}`);
        if (ch.id === "emag") {
          // Pozele pe celelalte platforme eMAG (BG, HU) — fiecare cu setul ei sau cel EN.
          const imagePushes = await pushImagesToSecondaryPlatforms(diff.matched || []);
          for (const img of imagePushes.filter((r) => r.count > 0 || !r.ok)) {
            results.push({
              channel: `emag_${img.platform}`,
              label: `eMAG ${img.platform.toUpperCase()} (poze)`,
              pulled: false,
              count: img.count,
              ok: img.ok,
              ...(img.error ? { error: img.error } : {}),
              ...(img.messages ? { messages: img.messages } : {}),
            });
          }
        }
      } catch (err) {
        console.error(`[push-all] ${ch.id}:`, err.message);
        if (!err?.expected) logCaught("push-all", err);
        entry.ok = false;
        entry.error = err.message || "Eroare la publicare";
      }
      results.push(entry);
    }
    return res.json({ ok: results.every((r) => r.ok), results });
  } catch (err) {
    console.error("[push-all]", err.message);
    logCaught("push-all", err);
    return res.status(500).json({ error: err.message || "Eroare la publicare pe canale" });
  } finally {
    pushAllRunning = false;
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

/* ---------------- comenzi ---------------- */

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

    const creds = await loadCredentials();
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
      const orders = await Promise.all(results.map(mapOrder));

      // Acumuleaza liniile de comanda local (istoric vanzari per produs).
      try {
        const lines = [];
        for (const order of orders) {
          for (const p of order.products || []) {
            lines.push({
              line_id: p.id,
              order_id: order.id,
              channel: order.channel || "emag",
              product_id: p.product_id,
              part_number: p.part_number,
              name: p.name,
              quantity: p.quantity,
              sale_price: p.sale_price,
              status: p.status,
              currency: p.currency,
              order_date: order.date,
            });
          }
        }
        await upsertOrderLines(lines);
      } catch (histErr) {
        console.warn("[orders] istoric comenzi:", histErr.message);
      }

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
    if (err?.code === "CREDENTIALS_MISSING") {
      return res.status(err.status || 400).json({
        error: err.message,
        code: err.code,
        settingsPath: err.settingsPath || "/settings.html#emag",
      });
    }
    return res.status(500).json({ error: err.message || "Eroare server" });
  }
});

// Comenzile salvate local (webhook / poller), cu liniile si preturile lor.
app.get("/api/orders/local", async (req, res) => {
  try {
    const orders = await listLocalOrders({
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ count: orders.length, orders });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Eroare server" });
  }
});

// Comenzi noi dupa watermark (polling notificari browser) — fara linii.
app.get("/api/orders/local/new", async (req, res) => {
  try {
    const after = req.query.after_created_at;
    const result = await listNewLocalOrders({
      afterCreatedAt: after || null,
      limit: req.query.limit,
    });
    const serverTime =
      result.serverTime instanceof Date
        ? result.serverTime.toISOString()
        : result.serverTime;
    return res.json({
      server_time: serverTime,
      count: result.orders.length,
      orders: result.orders,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Eroare server" });
  }
});

/* ---------------- Web Push (bara notificări telefon) ---------------- */

app.get("/api/push/vapid-public-key", async (_req, res) => {
  try {
    await initPush();
    return res.json({ publicKey: getPublicKey() });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Eroare VAPID" });
  }
});

app.post("/api/push/subscribe", async (req, res) => {
  try {
    await saveSubscription(req.body, req.get("user-agent"));
    return res.json({ ok: true });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || "Eroare subscribe" });
  }
});

app.post("/api/push/unsubscribe", async (req, res) => {
  try {
    await removeSubscription(req.body?.endpoint);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || "Eroare unsubscribe" });
  }
});

app.post("/api/push/test", async (_req, res) => {
  try {
    const result = await sendTestPush();
    if (result.total === 0) {
      return res.status(400).json({
        ok: false,
        error:
          "Niciun dispozitiv abonat. Activează notificările pe telefon (Setări → Notificări).",
      });
    }
    if (result.sent === 0) {
      return res.status(502).json({
        ok: false,
        ...result,
        error:
          "Push-ul nu a fost livrat către niciun dispozitiv. Verifică logurile backend și permisiunea notificărilor în Brave.",
      });
    }
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Eroare test push",
    });
  }
});

app.get("/api/stock-movements", async (req, res) => {
  try {
    return res.json({ movements: await listStockMovements({ limit: req.query.limit }) });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Eroare server" });
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
  try {
    await initPush();
    console.log("[push] Web Push activ (VAPID OK)");
  } catch (err) {
    console.warn("[push] init eșuat:", err.message);
  }
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
  startEmagOrderPoller();
  startTrendyolOrderPoller();
}

// Plasa de siguranta pentru callback-uri eMAG pierdute (comenzi noi si anulari).
function startEmagOrderPoller() {
  const minutes = Number(process.env.EMAG_ORDER_POLL_MINUTES ?? 5);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log("[order-poll] dezactivat (EMAG_ORDER_POLL_MINUTES=0)");
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollRecentEmagOrders({ lookbackMinutes: Math.max(30, minutes * 3) });
    } catch (err) {
      if (err?.code !== "CREDENTIALS_MISSING") {
        console.error("[order-poll]", err.message);
        void log({
          level: "error",
          source: "server",
          category: "webhook-emag",
          message: `Poll comenzi esuat: ${err.message}`,
          detail: { stack: err.stack },
        });
      }
    } finally {
      running = false;
    }
  };
  setInterval(tick, minutes * 60 * 1000);
  setTimeout(tick, 15 * 1000);
  console.log(`[order-poll] pornit la fiecare ${minutes} min`);
}

// Plasa de siguranta pentru Trendyol: merge si fara webhook; acopera si anularile din ultimele zile.
function startTrendyolOrderPoller() {
  const minutes = Number(process.env.TRENDYOL_ORDER_POLL_MINUTES ?? 5);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log("[trendyol-order-poll] dezactivat (TRENDYOL_ORDER_POLL_MINUTES=0)");
    return;
  }
  const lookbackHours = Number(process.env.TRENDYOL_ORDER_LOOKBACK_HOURS ?? 72);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollRecentTrendyolOrders({ lookbackMinutes: Math.max(60, lookbackHours * 60) });
    } catch (err) {
      if (err?.code !== "CREDENTIALS_MISSING") {
        console.error("[trendyol-order-poll]", err.message);
        void log({
          level: "error",
          source: "server",
          category: "webhook-trendyol",
          message: `Poll comenzi Trendyol esuat: ${err.message}`,
          detail: { stack: err.stack },
        });
      }
    } finally {
      running = false;
    }
  };
  setInterval(tick, minutes * 60 * 1000);
  setTimeout(tick, 20 * 1000);
  console.log(`[trendyol-order-poll] pornit la fiecare ${minutes} min`);
}

start().catch((err) => {
  console.error("Nu am putut porni serverul:", err);
  process.exit(1);
});
