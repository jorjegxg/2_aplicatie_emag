const express = require("express");
const path = require("path");
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
  saveSnapshot,
  upsertListingFromRemote,
  getCatalogRows,
  updateListing,
  getListings,
  updateProduct,
  getChannelDiff,
  getChannelStats,
  getListingCosts,
  lookupCatalogPretCumparare,
  ensureSchema,
} = require("./marketplace-db");
const { getChannel, listChannels } = require("./channels");
const {
  log,
  queryLogs,
  getLogFacets,
  clearLogs,
  pruneLogs,
} = require("./logs-db");
const { ITEMS_PER_PAGE, loadCredentials, authCandidates, authHeader, logAuthAttempt, logAuthResult, savePreferredAuthLabel, emagOrderRead } = require("./emag-client");

const PORT = process.env.PORT || 3000;
const COMMISSION_FETCH_CONCURRENCY = 5;
const MAX_PULL_PAGES = 50;

const app = express();
// Exportul trimite tot tabelul intr-un singur POST - limita implicita de 100kb e prea mica.
app.use("/api/products/export", express.json({ limit: "25mb" }));
app.use(express.json());

/** Categoria de log derivata din calea API, pentru filtrarea din /logs.html. */
function categoryForPath(urlPath) {
  const p = urlPath.split("?")[0];
  if (p.startsWith("/api/sync/pull")) return "sync-pull";
  if (p.startsWith("/api/sync/diff")) return "sync-diff";
  if (p.startsWith("/api/products/sync-prices")) return "sync-prices";
  if (p.startsWith("/api/products/fetch-commission")) return "commission";
  if (p.startsWith("/api/products/export")) return "export";
  if (p.includes("/history")) return "history";
  if (p.startsWith("/api/catalog/listing")) return "listing-patch";
  if (p.startsWith("/api/catalog/product")) return "product-patch";
  if (p.startsWith("/api/orders")) return "orders";
  if (p.startsWith("/api/settings")) return "settings";
  return "http";
}

// Logheaza fiecare apel /api/*, mai putin rutele paginii de logs (altfel se auto-logheaza in bucla).
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/") || req.path.startsWith("/api/logs")) return next();
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

app.use(express.static(path.join(__dirname, "public")));

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
    detail: { stack: err?.stack, messages: err?.messages, detail: err?.detail },
  });
  return res.status(status).json({
    error: err?.message || fallback,
    messages: err?.messages || [],
    detail: err?.detail || undefined,
  });
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
    alte_costuri: costs?.alte_costuri ?? null,
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
    });

    return res.json(saved);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la salvare setări" });
  }
});

/* ---------------- catalog local (sursa tabelului principal) ---------------- */

app.get("/api/channels", async (_req, res) => {
  try {
    const channels = await Promise.all(
      listChannels().map(async (c) => ({
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

// Alias pentru compatibilitate — tabelul principal citeste acum din DB, nu din eMAG.
app.get("/api/products", async (req, res) => {
  try {
    const channel = normalizeChannel(req.query.channel);
    const products = await getCatalogRows(channel);
    const stats = await getChannelStats(channel);
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

/** Trage toate ofertele de la canal in DB: snapshot + upsert listing. */
app.post("/api/sync/pull", async (req, res) => {
  const channelName = normalizeChannel(req.query.channel ?? req.body?.channel);
  try {
    const channel = getChannel(channelName);

    let page = 1;
    let created = 0;
    let updated = 0;
    let total = 0;
    let authUsed = null;

    while (page <= MAX_PULL_PAGES) {
      const result = await channel.fetchListings({ page });
      const listings = result.listings || [];
      authUsed = result.authUsed || authUsed;

      for (const remote of listings) {
        await saveSnapshot(channelName, remote);
        const { created: isNew } = await upsertListingFromRemote(channelName, remote);
        if (isNew) created += 1;
        else updated += 1;
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

    const stats = await getChannelStats(channelName);
    console.log(
      `[sync-pull] ${channelName}: ${total} oferte (${created} noi, ${updated} actualizate)`
    );
    return res.json({
      ok: true,
      channel: channelName,
      count: total,
      created,
      updated,
      pages: page,
      authUsed,
      last_sync: stats.last_sync,
    });
  } catch (err) {
    console.error("[sync-pull]", err.message);
    logCaught("sync-pull", err);
    return sendChannelError(res, err, "Eroare la preluare de la canal");
  }
});

/** Trimite catre canal ofertele cerute, cu valorile din DB. */
app.post("/api/products/sync-prices", async (req, res) => {
  const channelName = normalizeChannel(req.query.channel ?? req.body?.channel);
  try {
    const channel = getChannel(channelName);

    // Frontend-ul trimite doar id-urile; valorile de adevar sunt cele din DB.
    const includeContent = req.body?.includeContent === true;
    const rawOffers = Array.isArray(req.body?.offers) ? req.body.offers : [];
    const ids = rawOffers
      .map((o) => (o && typeof o === "object" ? o.id : o))
      .map((v) => String(v ?? "").trim())
      .filter(Boolean);

    if (ids.length === 0) {
      return res.status(400).json({ error: "Nicio ofertă de sincronizat" });
    }

    const listings = await getListings(channelName, ids);
    if (listings.length === 0) {
      return res.status(404).json({ error: "Ofertele nu există în DB — sincronizează cu canalul" });
    }

    const offers = [];
    for (const l of listings) {
      const effectiveMin =
        l.pret_minim_override != null && Number.isFinite(Number(l.pret_minim_override))
          ? Number(l.pret_minim_override)
          : l.min_sale_price;
      offers.push(
        channel.buildPushPayload({
          id: l.external_id,
          name: l.name,
          description: l.description,
          sale_price: l.sale_price,
          recommended_price: l.recommended_price,
          min_sale_price: effectiveMin,
          max_sale_price: l.max_sale_price,
          general_stock: l.general_stock,
          stock:
            l.stock_json == null
              ? null
              : typeof l.stock_json === "object"
                ? l.stock_json
                : JSON.parse(l.stock_json),
          handling_time:
            l.handling_time_json == null
              ? null
              : typeof l.handling_time_json === "object"
                ? l.handling_time_json
                : JSON.parse(l.handling_time_json),
          status: l.status,
          vat_id: l.vat_id,
        }, { includeContent })
      );
    }

    const result = await channel.pushListings(offers);

    // eMAG proceseaza salvarea asincron (5-10 min), deci NU marchez snapshot-ul ca
    // actualizat: ce e pe canal se afla doar la urmatorul pull. Retin doar ce am trimis.
    for (const o of offers) {
      try {
        await recordPretEmagIfChanged(o.id, o.sale_price, "RON", "sync");
      } catch (histErr) {
        console.warn("[sync-prices] istoric pret:", histErr.message);
      }
    }

    return res.json({ ok: true, channel: channelName, pending: true, ...result });
  } catch (err) {
    console.error("[sync-prices]", err.message);
    logCaught("sync-prices", err);
    return sendChannelError(res, err, "Eroare la sync prețuri");
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
      const orders = await Promise.all(results.map(mapOrder));

      // Acumuleaza liniile de comanda local (istoric vanzari per produs).
      try {
        const lines = [];
        for (const order of orders) {
          for (const p of order.products || []) {
            lines.push({
              line_id: p.id,
              order_id: order.id,
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
  await pruneLogs(14);
  app.listen(PORT, () => {
    console.log(`Server pornit: http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Nu am putut porni serverul:", err);
  process.exit(1);
});