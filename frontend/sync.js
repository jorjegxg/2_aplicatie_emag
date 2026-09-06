/* Comparatie: valorile mele din DB vs oglinda remote (eMAG = cache memorie TTL). */

const CHANNEL_KEY = "marketplace-channel";
const PRICING_CACHE_KEY = "sync-pricing-cache-v1";
const DIFF_CACHE_KEY = "sync-diff-cache-v1";

const channelSelect = document.getElementById("channel-select");
const btnPull = document.getElementById("btn-pull");
const btnFetchCommission = document.getElementById("btn-fetch-commission");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("sync-summary");
const filterStatusEl = document.getElementById("filter-status");
const filterStatusText = document.getElementById("filter-status-text");
const btnClearFilters = document.getElementById("btn-clear-filters");

let currentChannel = localStorage.getItem(CHANNEL_KEY) || "emag";
let currentData = null;
let loading = false;
let pulling = false;
let fetchingCommission = false;
/** null | matched | diff | only_remote | only_local | unlinked */
let summaryFilter = null;

const SUMMARY_LABELS = {
  matched: "Comune",
  diff: "Cu diferențe",
  only_remote: "Doar pe marketplace",
  only_local: "Doar local",
  unlinked: "Nelegate",
};

function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function titleAttr(text) {
  if (text == null || text === "" || text === "—") return "";
  return ` title="${escapeHtml(String(text))}"`;
}

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = "status";
  if (kind === "loading") statusEl.classList.add("is-loading");
  else if (kind === "error") statusEl.classList.add("is-error");
  else if (kind === "ok") statusEl.classList.add("is-ok");
}

function setStatusHtml(html, kind) {
  statusEl.innerHTML = html || "";
  statusEl.className = "status";
  if (kind === "loading") statusEl.classList.add("is-loading");
  else if (kind === "error") statusEl.classList.add("is-error");
  else if (kind === "ok") statusEl.classList.add("is-ok");
}

function settingsPathForChannel(channel) {
  const c = String(channel || currentChannel || "emag").toLowerCase();
  return `/settings.html#${c === "trendyol" ? "trendyol" : "emag"}`;
}

function credentialsMissingHtml(message, settingsPath) {
  const path = settingsPath || settingsPathForChannel();
  const msg = escapeHtml(message || "Credentiale lipsă.");
  return `${msg} <a class="status-settings-link" href="${escapeHtml(path)}">Mergi la Setări</a>`;
}

function showApiError(data, fallback) {
  if (data && data.code === "CREDENTIALS_MISSING") {
    setStatusHtml(
      credentialsMissingHtml(data.error, data.settingsPath || settingsPathForChannel()),
      "error"
    );
    return;
  }
  setStatus((data && data.error) || fallback || "Eroare", "error");
}

/** @type {Record<string, boolean>} */
let channelConfiguredMap = {};

async function refreshChannelConfigured() {
  try {
    const res = await fetch("/api/channels");
    const data = await res.json();
    if (!res.ok) return;
    const map = {};
    for (const c of data.channels || []) {
      map[c.id] = c.configured !== false;
    }
    channelConfiguredMap = map;
  } catch {
    /* ignore */
  }
}

function warnIfChannelUnconfigured() {
  if (channelConfiguredMap[currentChannel] === false) {
    setStatusHtml(
      credentialsMissingHtml(
        `Credentiale lipsă pentru ${currentChannel}.`,
        settingsPathForChannel(currentChannel)
      ),
      "error"
    );
    return true;
  }
  return false;
}

function formatStamp(iso) {
  if (!iso) return "niciodată";
  try {
    return new Date(iso).toLocaleString("ro-RO");
  } catch {
    return String(iso);
  }
}

function bucketOfferIds(bucket) {
  if (!currentData) return new Set();
  if (bucket === "matched") {
    return new Set(currentData.matched.map((m) => String(m.external_id)));
  }
  if (bucket === "diff") {
    return new Set(
      currentData.matched.filter((m) => m.diff_count > 0).map((m) => String(m.external_id))
    );
  }
  const list = currentData[bucket];
  if (!Array.isArray(list)) return new Set();
  return new Set(list.map((r) => String(r.external_id)));
}

function renderSummary(data) {
  const diffRows = data.matched.filter((m) => m.diff_count > 0).length;
  const chips = [
    {
      static: true,
      html: `Ultima preluare: <strong>${escapeHtml(formatStamp(data.last_sync))}</strong>`,
    },
    { filter: "matched", label: "Comune", count: data.matched.length },
    {
      filter: "diff",
      label: "Cu diferențe",
      count: diffRows,
      warn: diffRows > 0,
    },
    { filter: "only_remote", label: "Doar pe marketplace", count: data.only_remote.length },
    { filter: "only_local", label: "Doar local", count: data.only_local.length },
    { filter: "unlinked", label: "Nelegate", count: data.unlinked.length },
  ];

  summaryEl.innerHTML = chips
    .map((c) => {
      if (c.static) return `<span class="sync-chip">${c.html}</span>`;
      const active = summaryFilter === c.filter;
      const cls = [
        "sync-chip",
        c.warn ? "is-diff" : "",
        active ? "is-active" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<button type="button" class="${cls}" data-filter="${c.filter}" aria-pressed="${
        active ? "true" : "false"
      }">${escapeHtml(c.label)}: <strong>${c.count}</strong></button>`;
    })
    .join("");
}

function applySummaryFilter() {
  summaryEl.querySelectorAll("button.sync-chip[data-filter]").forEach((btn) => {
    const on = btn.dataset.filter === summaryFilter;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  applyPricingFilters();
}

function render(data) {
  renderSummary(data);
}

function saveDiffCache(data) {
  try {
    sessionStorage.setItem(
      DIFF_CACHE_KEY,
      JSON.stringify({ channel: currentChannel, data, savedAt: new Date().toISOString() })
    );
  } catch (err) {
    console.warn("cache diff:", err.message);
  }
}

function readDiffCache() {
  try {
    const raw = sessionStorage.getItem(DIFF_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.data || parsed.channel !== currentChannel) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearClientSyncCaches() {
  try {
    sessionStorage.removeItem(PRICING_CACHE_KEY);
    sessionStorage.removeItem(DIFF_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

function restoreDiffCache() {
  if (channelConfiguredMap[currentChannel] === false) {
    clearClientSyncCaches();
    return false;
  }
  const cached = readDiffCache();
  if (!cached) return false;
  if (!cached.data?.last_sync) {
    clearClientSyncCaches();
    return false;
  }
  currentData = cached.data;
  render(cached.data);
  if (pricingProducts.length) renderPricing();
  return true;
}

async function loadDiff() {
  if (loading) return;
  loading = true;
  setStatus("Se compară…", "loading");
  try {
    const res = await fetch(`/api/sync/diff?channel=${encodeURIComponent(currentChannel)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    currentData = data;
    saveDiffCache(data);
    render(data);
    if (pricingProducts.length) renderPricing();
    const diffRows = data.matched.filter((m) => m.diff_count > 0).length;
    if (!data.last_sync) {
      clearClientSyncCaches();
      setStatus(
        `Nicio preluare de la ${currentChannel} încă — apasă „Preia de la marketplace".`,
        "error"
      );
    } else {
      setStatus(
        diffRows === 0
          ? "Fără diferențe față de ultima preluare."
          : `${diffRows} produse diferă față de marketplace.`,
        diffRows === 0 ? "ok" : "loading"
      );
    }
  } catch (err) {
    setStatus(err.message || "Eroare la comparare", "error");
  } finally {
    loading = false;
  }
}

async function pullFromChannel() {
  if (pulling) return;
  if (warnIfChannelUnconfigured()) return;
  pulling = true;
  btnPull.disabled = true;
  setStatus(`Se preiau ofertele de la ${currentChannel}…`, "loading");
  try {
    const res = await fetch(`/api/sync/pull?channel=${encodeURIComponent(currentChannel)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) {
      showApiError(data, `HTTP ${res.status}`);
      return;
    }
    setStatus(
      `Preluate ${data.count} oferte în cache (comparație) — catalogul local neschimbat.`,
      "ok"
    );
    await Promise.all([loadDiff(), loadPricing()]);
  } catch (err) {
    setStatus(err.message || "Eroare la preluare", "error");
  } finally {
    pulling = false;
    btnPull.disabled = false;
  }
}

/** Preia comisionul eMAG pentru toate produsele din DB si il salveaza pe catalog. */
async function fetchCommission() {
  if (fetchingCommission) return;
  if (warnIfChannelUnconfigured()) return;
  fetchingCommission = true;
  btnFetchCommission.disabled = true;
  setStatus("Se încarcă produsele din DB…", "loading");
  try {
    const catalogRes = await fetch(`/api/catalog?channel=${encodeURIComponent(currentChannel)}`);
    const catalog = await catalogRes.json();
    if (!catalogRes.ok) throw new Error(catalog.error || `HTTP ${catalogRes.status}`);

    const items = (Array.isArray(catalog.products) ? catalog.products : [])
      .map((p) => ({ id: Number(p.id), sale_price: Number(p.sale_price) }))
      .filter((item) => Number.isFinite(item.id));

    if (!items.length) {
      setStatus("Niciun produs în DB.", "error");
      return;
    }

    setStatus(`Preiau comision eMAG (${items.length} produse)…`, "loading");
    const res = await fetch(
      `/api/products/fetch-commission?channel=${encodeURIComponent(currentChannel)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      showApiError(data, `HTTP ${res.status}`);
      return;
    }

    const errCount = data.errorCount || 0;
    setStatus(
      errCount
        ? `Comision preluat: ${data.count}/${items.length} (${errCount} erori).`
        : `Comision preluat pentru ${data.count} produse.`,
      errCount ? "error" : "ok"
    );
    await Promise.all([loadDiff(), loadPricing()]);
  } catch (err) {
    setStatus(err.message || "Eroare la preluare comision", "error");
  } finally {
    fetchingCommission = false;
    btnFetchCommission.disabled = false;
  }
}

/* ================= Preturi si marja ================= */

const {
  DEFAULT_PROcentaj_EMAG,
  formatPrice,
  formatPercent,
  relativeTimeRo,
  parseSortNumber,
  alteFromProcentaj,
  calcProfit,
  calcPretMinimProfit,
  calcProcentajProfit,
  isEmagCommissionFetched,
  formatProcentajEmagDisplay,
  procentajEmagTooltip,
  procentajEmagInputHtml,
  createPersister,
  stockSumFromArr,
} = window.Pricing;

const CHANNEL_PRICE_LABELS = { emag: "Pret emag", trendyol: "Pret trendyol" };

/** Diff API key → coloană din tabelul Prețuri și marjă. */
const DIFF_KEY_TO_COL = {
  sale_price: "pret_emag",
  recommended_price: "prp",
  min_sale_price: "pret_minim",
  max_sale_price: "pret_maxim",
  general_stock: "stoc",
};

const COMPACT_PRICING_KEY = "sync-compact-pricing";
const TABLE_FULLSCREEN_KEY = "sync-table-fullscreen";

const pageEl = document.querySelector(".page");
const pricingTable = document.getElementById("pricing-table");
const pricingBody = document.getElementById("pricing-body");
const pricingWrap = document.getElementById("pricing-wrap");
const thPretCanal = document.getElementById("th-pret-canal");
const btnPush = document.getElementById("btn-push");
const btnCompactPricing = document.getElementById("btn-compact-pricing");
const btnTableFullscreen = document.getElementById("btn-table-fullscreen");
const syncInfoBanner = document.getElementById("sync-info-banner");
const filterRow = pricingTable.querySelector("thead tr.filter-row");

function matchedDiffRow(offerId) {
  if (!currentData || !Array.isArray(currentData.matched)) return null;
  return (
    currentData.matched.find((m) => String(m.external_id) === String(offerId)) || null
  );
}

function diffKeysForOffer(offerId) {
  const keys = new Set();
  const row = matchedDiffRow(offerId);
  if (!row) return keys;
  for (const f of row.fields || []) {
    if (f.differs) keys.add(f.key);
  }
  return keys;
}

/** Field diff (mine/theirs) pentru o coloană din tabel, dacă diferă. */
function diffFieldForCol(offerId, col) {
  const row = matchedDiffRow(offerId);
  if (!row) return null;
  let key = null;
  for (const [k, mapped] of Object.entries(DIFF_KEY_TO_COL)) {
    if (mapped === col) {
      key = k;
      break;
    }
  }
  if (!key) return null;
  const field = (row.fields || []).find((f) => f.key === key);
  return field && field.differs ? field : null;
}

/** Celulă cu valoare locală + marketplace + Δ când diferă. */
function priceCellWithDiff(offerId, col, mineText, currency, mineRaw) {
  const field = diffFieldForCol(offerId, col);
  const dataVal =
    mineRaw != null && mineRaw !== ""
      ? ` data-value="${escapeHtml(mineRaw)}"`
      : "";
  if (!field) {
    return { html: mineText, title: titleAttr(mineText), dataVal };
  }

  const isStock = field.key === "general_stock";
  const theirsText = isStock
    ? field.theirs == null || field.theirs === ""
      ? "—"
      : String(field.theirs)
    : formatPrice(field.theirs, currency);
  const mineNum = Number(field.mine);
  const theirsNum = Number(field.theirs);
  let deltaText = "";
  if (
    !isStock &&
    Number.isFinite(mineNum) &&
    Number.isFinite(theirsNum)
  ) {
    const d = mineNum - theirsNum;
    const sign = d > 0 ? "+" : "";
    deltaText = ` · Δ ${sign}${d.toFixed(2)}`;
  }
  const tip = `Local (Produse): ${mineText} · Marketplace: ${theirsText}${deltaText}`;
  const html = `<span class="diff-mine">${mineText}</span><span class="diff-vs">MP: ${escapeHtml(
    theirsText
  )}${escapeHtml(deltaText)}</span>`;
  return { html, title: ` title="${escapeHtml(tip)}"`, dataVal };
}

/** pret_transport (vechi) → alte_costuri; evita drop din sync-column-order. */
function migrateLegacyCostCols(cols) {
  const OLD = new Set(["pret_transport", "procentaj_alte_costuri"]);
  const out = [];
  let insertedAlte = false;
  for (const c of cols) {
    if (c === "pret_transport") {
      if (!insertedAlte && !out.includes("alte_costuri")) {
        out.push("alte_costuri");
        insertedAlte = true;
      }
      continue;
    }
    if (OLD.has(c)) continue;
    if (out.includes(c)) continue;
    out.push(c);
  }
  return out;
}

/* Chei separate de pagina de produse: ascunderea/ordinea sunt per pagina. */
const columns = window.TableColumns.create({
  table: pricingTable,
  tbody: pricingBody,
  menuEl: document.getElementById("col-menu"),
  buttonEl: document.getElementById("btn-columns"),
  hiddenKey: "sync-hidden-columns",
  orderKey: "sync-column-order",
  migrate: migrateLegacyCostCols,
});

const PRICING_COL_COUNT = columns.defaultOrder.length;

let pricingProducts = [];
let settings = {};
let pricingSortCol = null;
let pricingSortDir = "asc";
let pushing = false;

const schedulePersistListing = createPersister({
  getChannel: () => currentChannel,
  onError: (err) => setStatus(err.message || "Eroare la salvare", "error"),
});

function globalPct(key) {
  const raw = settings[key];
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Costurile derivate: override pe catalog, altfel procentaj global × preț cumpărare. */
function rowCosts(product) {
  const pretCumparare = product.pret_cumparare ?? "";
  const alte =
    product.alte_costuri != null && Number.isFinite(Number(product.alte_costuri))
      ? Number(product.alte_costuri)
      : alteFromProcentaj(globalPct("procentaj_alte_costuri") ?? "", pretCumparare);
  return { pretCumparare, alte };
}

function rowPctEmag(product) {
  const raw = product.procentaj_emag;
  return raw != null && Number.isFinite(Number(raw))
    ? Number(raw)
    : DEFAULT_PROcentaj_EMAG;
}

function pricingRowHtml(product, index) {
  const currency = product.currency || "RON";
  const { pretCumparare, alte } = rowCosts(product);
  const pct = rowPctEmag(product);
  const commissionValue =
    product.commission_value != null && Number.isFinite(Number(product.commission_value))
      ? Number(product.commission_value)
      : null;
  const fetchedAt = product.commission_fetched_at ?? "";
  const isFetched = isEmagCommissionFetched(commissionValue);
  const tooltip = escapeHtml(procentajEmagTooltip(commissionValue, fetchedAt));
  const hasOverride = !isFetched && Number(pct) !== DEFAULT_PROcentaj_EMAG;

  const minProfit = calcPretMinimProfit(pretCumparare, alte, pct);
  const profit = calcProfit(product.sale_price, pretCumparare, alte, pct);
  const procentaj = calcProcentajProfit(
    product.sale_price,
    pretCumparare,
    alte,
    pct
  );

  const diffKeys = diffKeysForOffer(product.id);
  const colDiff = (col) => {
    for (const [key, mapped] of Object.entries(DIFF_KEY_TO_COL)) {
      if (mapped === col && diffKeys.has(key)) return " is-diff";
    }
    return "";
  };
  const cellClass = (col, extra = "") =>
    columns.cellClass(col, `${extra}${colDiff(col)}`.trim());

  const commissionCell = isFetched
    ? `<td data-col="procentaj_emag"${cellClass(
        "procentaj_emag",
        "col-procentaj-emag"
      )}${tooltip ? ` title="${tooltip}"` : ""}>${escapeHtml(
        formatProcentajEmagDisplay(pct)
      )}</td>`
    : `<td data-col="procentaj_emag"${cellClass(
        "procentaj_emag",
        "col-procentaj-emag"
      )}>${procentajEmagInputHtml(pct, hasOverride)}</td>`;

  const pretMinim =
    product.pret_minim_override != null &&
    Number.isFinite(Number(product.pret_minim_override))
      ? Number(product.pret_minim_override)
      : product.min_sale_price;
  const generalStock = Number(product.general_stock);
  const stoc = Number.isFinite(generalStock)
    ? generalStock
    : stockSumFromArr(product.stock);

  const nameText = product.name || "—";
  const descText = product.description || "—";
  const pretEmagText = formatPrice(product.sale_price, currency);
  const prpText = formatPrice(product.recommended_price, currency);
  const pretMinimText = formatPrice(pretMinim, currency);
  const pretMaximText = formatPrice(product.max_sale_price, currency);
  const stocText = stoc === "" || stoc == null ? "—" : String(stoc);

  const pretEmagDiff = priceCellWithDiff(
    product.id,
    "pret_emag",
    pretEmagText,
    currency,
    product.sale_price
  );
  const prpDiff = priceCellWithDiff(
    product.id,
    "prp",
    prpText,
    currency,
    product.recommended_price
  );
  const pretMinimDiff = priceCellWithDiff(
    product.id,
    "pret_minim",
    pretMinimText,
    currency,
    pretMinim
  );
  const pretMaximDiff = priceCellWithDiff(
    product.id,
    "pret_maxim",
    pretMaximText,
    currency,
    product.max_sale_price
  );
  const stocDiff = priceCellWithDiff(
    product.id,
    "stoc",
    escapeHtml(stocText),
    currency,
    stoc
  );

  const cells = {
    index: `<td data-col="index"${cellClass("index")}>${index}</td>`,
    id: `<td data-col="id"${cellClass("id")}${titleAttr(product.id)}>${escapeHtml(product.id)}</td>`,
    part_number: `<td data-col="part_number"${cellClass("part_number")}${titleAttr(
      product.part_number
    )}>${escapeHtml(product.part_number) || "—"}</td>`,
    id_familie: `<td data-col="id_familie"${cellClass("id_familie")}${titleAttr(
      product.id_familie
    )}>${escapeHtml(product.id_familie) || "—"}</td>`,
    familie: `<td data-col="familie"${cellClass("familie")}${titleAttr(product.familie)}>${
      escapeHtml(product.familie) || "—"
    }</td>`,
    name: `<td data-col="name"${cellClass("name", "col-name")}${titleAttr(nameText)}>${
      escapeHtml(product.name) || "—"
    }</td>`,
    description: `<td data-col="description"${cellClass(
      "description",
      "col-description-ro"
    )}${titleAttr(descText)}>${escapeHtml(product.description) || "—"}</td>`,
    pret_cumparare: `<td data-col="pret_cumparare"${cellClass(
      "pret_cumparare"
    )}>${formatPrice(pretCumparare, currency)}</td>`,
    alte_costuri: `<td data-col="alte_costuri"${cellClass("alte_costuri")}>${formatPrice(
      alte,
      currency
    )}</td>`,
    pret_emag: `<td data-col="pret_emag"${cellClass(
      "pret_emag",
      "col-pret-emag"
    )}${pretEmagDiff.dataVal}${pretEmagDiff.title}>${pretEmagDiff.html}</td>`,
    prp: `<td data-col="prp"${cellClass("prp")}${prpDiff.dataVal}${prpDiff.title}>${
      prpDiff.html
    }</td>`,
    pret_minim: `<td data-col="pret_minim"${cellClass("pret_minim")}${
      pretMinimDiff.dataVal
    }${pretMinimDiff.title}>${pretMinimDiff.html}</td>`,
    pret_maxim: `<td data-col="pret_maxim"${cellClass("pret_maxim")}${
      pretMaximDiff.dataVal
    }${pretMaximDiff.title}>${pretMaximDiff.html}</td>`,
    stoc: `<td data-col="stoc"${cellClass("stoc")}${stocDiff.dataVal}${stocDiff.title}>${
      stocDiff.html
    }</td>`,
    procentaj_emag: commissionCell,
    pret_minim_profit: `<td data-col="pret_minim_profit"${cellClass(
      "pret_minim_profit"
    )}>${formatPrice(minProfit, currency)}</td>`,
    profit: `<td data-col="profit"${cellClass("profit", "col-profit")}>${formatPrice(
      profit,
      currency
    )}</td>`,
    procentaj_profit: `<td data-col="procentaj_profit"${cellClass(
      "procentaj_profit",
      "col-procentaj-profit"
    )}>${formatPercent(procentaj)}</td>`,
    ean: `<td data-col="ean"${cellClass("ean")}${titleAttr(product.ean)}>${
      escapeHtml(product.ean) || "—"
    }</td>`,
    pnk: `<td data-col="pnk"${cellClass("pnk")}${titleAttr(product.part_number_key)}>${
      escapeHtml(product.part_number_key) || "—"
    }</td>`,
    pret_emag_schimbat: `<td data-col="pret_emag_schimbat"${cellClass(
      "pret_emag_schimbat",
      "col-pret-schimbat"
    )}${
      product.pret_emag_last_change
        ? ` title="${escapeHtml(new Date(product.pret_emag_last_change).toLocaleString("ro-RO"))}"`
        : ""
    }>${escapeHtml(relativeTimeRo(product.pret_emag_last_change))}</td>`,
    istoric: `<td data-col="istoric"${cellClass(
      "istoric",
      "col-istoric"
    )}><button type="button" class="btn-history" data-offer-id="${escapeHtml(
      product.id
    )}" aria-label="Istoric preț și comenzi" title="Istoric preț și comenzi">📈</button></td>`,
  };

  const rowClass = diffKeys.size > 0 ? ' class="has-diff"' : "";
  return `<tr data-offer-id="${escapeHtml(product.id)}"${rowClass}>
    ${columns.order.map((col) => cells[col] || "").join("")}
  </tr>`;
}

function renderPricing() {
  thPretCanal.textContent = CHANNEL_PRICE_LABELS[currentChannel] || "Preț canal";
  if (!pricingProducts.length) {
    pricingBody.innerHTML = `<tr class="empty-row"><td colspan="${PRICING_COL_COUNT}">Niciun produs în DB pentru canalul selectat.</td></tr>`;
    updateFilterStatus(0, 0);
    return;
  }
  pricingBody.innerHTML = pricingProducts
    .map((p, i) => pricingRowHtml(p, i + 1))
    .join("");
  columns.applyVisibility();
  applyPricingFilters();
}

/** Recalculeaza pe loc marja unui rand dupa ce s-a schimbat comisionul. */
function refreshPricingRow(tr, product) {
  const currency = product.currency || "RON";
  const { pretCumparare, alte } = rowCosts(product);
  const pct = rowPctEmag(product);
  const minProfit = calcPretMinimProfit(pretCumparare, alte, pct);
  const profit = calcProfit(product.sale_price, pretCumparare, alte, pct);
  const procentaj = calcProcentajProfit(
    product.sale_price,
    pretCumparare,
    alte,
    pct
  );

  const minCell = tr.querySelector("td[data-col='pret_minim_profit']");
  if (minCell) minCell.textContent = formatPrice(minProfit, currency);
  const profitCell = tr.querySelector("td[data-col='profit']");
  if (profitCell) profitCell.textContent = formatPrice(profit, currency);
  const pctCell = tr.querySelector("td[data-col='procentaj_profit']");
  if (pctCell) {
    pctCell.textContent = formatPercent(procentaj);
    pctCell.classList.remove("pct-1", "pct-2", "is-below-emag");
  }
}

async function loadPricing() {
  try {
    const [settingsRes, catalogRes] = await Promise.all([
      fetch("/api/settings"),
      fetch(`/api/catalog?channel=${encodeURIComponent(currentChannel)}`),
    ]);
    const settingsData = await settingsRes.json();
    const catalog = await catalogRes.json();
    if (!catalogRes.ok) throw new Error(catalog.error || `HTTP ${catalogRes.status}`);
    settings = settingsRes.ok ? settingsData : {};
    pricingProducts = Array.isArray(catalog.products) ? catalog.products : [];
    savePricingCache();
    renderPricing();
  } catch (err) {
    setStatus(err.message || "Eroare la încărcarea prețurilor", "error");
    pricingBody.innerHTML = `<tr class="empty-row"><td colspan="${PRICING_COL_COUNT}">${escapeHtml(
      err.message || "Eroare"
    )}</td></tr>`;
  }
}

function savePricingCache() {
  try {
    sessionStorage.setItem(
      PRICING_CACHE_KEY,
      JSON.stringify({
        channel: currentChannel,
        products: pricingProducts,
        settings,
        savedAt: new Date().toISOString(),
      })
    );
  } catch (err) {
    console.warn("cache pricing:", err.message);
  }
}

function readPricingCache() {
  try {
    const raw = sessionStorage.getItem(PRICING_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.products) || data.channel !== currentChannel) return null;
    return data;
  } catch {
    return null;
  }
}

function restorePricingCache() {
  if (channelConfiguredMap[currentChannel] === false) {
    clearClientSyncCaches();
    return false;
  }
  const data = readPricingCache();
  if (!data || data.products.length === 0) return false;
  pricingProducts = data.products;
  settings = data.settings && typeof data.settings === "object" ? data.settings : {};
  renderPricing();
  const when = data.savedAt ? new Date(data.savedAt).toLocaleString("ro-RO") : "";
  setStatus(
    `Cache: ${pricingProducts.length} produse` + (when ? ` (din ${when})` : ""),
    "ok"
  );
  return true;
}

/* ---------- editare comision ---------- */

function findProduct(offerId) {
  return pricingProducts.find((p) => String(p.id) === String(offerId));
}

function syncCommissionCell(tr) {
  const cell = tr.querySelector("td[data-col='procentaj_emag']");
  const input = cell?.querySelector("input.input-procentaj-emag");
  if (!input) return;
  const n = Number(input.value);
  const overridden = Number.isFinite(n) && n !== DEFAULT_PROcentaj_EMAG;
  const resetBtn = cell.querySelector("button.btn-reset-emag-pct");
  if (resetBtn) resetBtn.hidden = !overridden;
}

pricingBody.addEventListener("input", (e) => {
  const input = e.target.closest("input.input-procentaj-emag");
  if (!input) return;
  const tr = input.closest("tr[data-offer-id]");
  const product = findProduct(tr?.dataset.offerId);
  if (!product) return;
  const n = Number(input.value);
  const isDefault = input.value === "" || !Number.isFinite(n) || n === DEFAULT_PROcentaj_EMAG;
  product.procentaj_emag = isDefault ? null : n;
  syncCommissionCell(tr);
  refreshPricingRow(tr, product);
  schedulePersistListing(
    product.id,
    { procentaj_emag: isDefault ? null : n },
    "procentaj-emag"
  );
});

pricingBody.addEventListener("click", (e) => {
  const historyBtn = e.target.closest("button.btn-history");
  if (historyBtn) {
    const product = findProduct(historyBtn.dataset.offerId);
    window.HistoryModal.open(historyBtn.dataset.offerId, product?.name || "");
    return;
  }

  const resetBtn = e.target.closest("button.btn-reset-emag-pct");
  if (resetBtn) {
    const tr = resetBtn.closest("tr[data-offer-id]");
    const product = findProduct(tr?.dataset.offerId);
    if (!product) return;
    const input = tr.querySelector("input.input-procentaj-emag");
    if (input) input.value = String(DEFAULT_PROcentaj_EMAG);
    product.procentaj_emag = null;
    syncCommissionCell(tr);
    refreshPricingRow(tr, product);
    schedulePersistListing(product.id, { procentaj_emag: null }, "procentaj-emag");
    return;
  }

  const td = e.target.closest("td[data-col]");
  if (td && !e.target.closest("button, input, a, label")) {
    cellTextTip?.toggleFromCell(td);
  }
});

/* ---------- tip text complet pe celule trunchiate ---------- */

function isCellOverflowing(td) {
  if (!td) return false;
  return td.scrollWidth > td.clientWidth + 1 || td.scrollHeight > td.clientHeight + 1;
}

function cellFullText(td) {
  if (!td) return "";
  const fromTitle = (td.getAttribute("title") || td.dataset.fullText || "").trim();
  if (fromTitle) return fromTitle;
  return (td.textContent || "").replace(/\s+/g, " ").trim();
}

function cellShownText(td) {
  return (td?.textContent || "").replace(/\s+/g, " ").trim();
}

function shouldShowCellTip(td) {
  if (!td) return false;
  if (isCellOverflowing(td)) return true;
  const full = cellFullText(td);
  if (!full || full === "—") return false;
  return full !== cellShownText(td);
}

function createCellTextTip() {
  let tip = document.getElementById("cell-text-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "cell-text-tip";
    tip.className = "cell-text-tip";
    tip.hidden = true;
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
  }

  let pinned = false;
  let activeTd = null;
  let hoverTimer = null;

  function positionTip(anchor) {
    const rect = anchor.getBoundingClientRect();
    tip.hidden = false;
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
    if (left < 8) left = 8;
    if (top + tipH > window.innerHeight - 8) top = rect.top - tipH - 6;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }

  function show(td, { pin = false } = {}) {
    if (!shouldShowCellTip(td)) return false;
    const text = cellFullText(td);
    if (!text || text === "—") return false;

    tip.textContent = text;
    activeTd = td;
    pinned = pin;
    tip.classList.toggle("is-pinned", pin);
    positionTip(td);
    return true;
  }

  function hide({ force = false } = {}) {
    if (pinned && !force) return;
    clearTimeout(hoverTimer);
    hoverTimer = null;
    tip.hidden = true;
    tip.textContent = "";
    tip.classList.remove("is-pinned");
    pinned = false;
    activeTd = null;
  }

  function stashNativeTitle(td) {
    if (td.title) {
      td.dataset.fullText = td.title;
      td.removeAttribute("title");
    }
  }

  function restoreNativeTitle(td) {
    if (td?.dataset.fullText && !td.getAttribute("title")) {
      td.setAttribute("title", td.dataset.fullText);
    }
  }

  function markOverflow(td) {
    if (!td || !td.matches("td[data-col]")) return;
    td.classList.toggle("is-cell-overflow", isCellOverflowing(td));
  }

  pricingBody.addEventListener("mouseover", (e) => {
    const td = e.target.closest("td[data-col]");
    if (!td || td === activeTd) return;
    if (e.target.closest("button, input, a, label")) return;
    markOverflow(td);
    if (!shouldShowCellTip(td)) return;

    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (pinned) return;
      stashNativeTitle(td);
      show(td, { pin: false });
    }, 280);
  });

  pricingBody.addEventListener("mouseout", (e) => {
    const td = e.target.closest("td[data-col]");
    if (!td) return;
    const related = e.relatedTarget;
    if (related && td.contains(related)) return;
    clearTimeout(hoverTimer);
    hoverTimer = null;
    if (!pinned) {
      hide({ force: true });
      restoreNativeTitle(td);
    }
  });

  document.addEventListener("click", (e) => {
    if (!pinned) return;
    if (tip.contains(e.target)) return;
    if (activeTd && activeTd.contains(e.target)) return;
    const prev = activeTd;
    hide({ force: true });
    restoreNativeTitle(prev);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const prev = activeTd;
    hide({ force: true });
    restoreNativeTitle(prev);
  });

  window.addEventListener(
    "scroll",
    () => {
      if (!tip.hidden && activeTd) positionTip(activeTd);
    },
    true
  );

  return {
    toggleFromCell(td) {
      if (!td) return;
      if (pinned && activeTd === td) {
        hide({ force: true });
        restoreNativeTitle(td);
        return;
      }
      stashNativeTitle(td);
      if (!show(td, { pin: true })) {
        restoreNativeTitle(td);
      }
    },
    hide,
  };
}

let cellTextTip = null;

/* ---------- filtrare + sortare ---------- */

function pricingCellText(tr, col) {
  const td = tr.querySelector(`td[data-col="${col}"]`);
  if (!td) return "";
  if (td.dataset.value != null && td.dataset.value !== "") {
    return String(td.dataset.value).trim();
  }
  const input = td.querySelector("input");
  if (input) return String(input.value ?? "").trim();
  const mine = td.querySelector(".diff-mine");
  if (mine) {
    const t = (mine.textContent || "").trim();
    return !t || t === "—" ? "" : t;
  }
  const text = (td.textContent || "").trim();
  return !text || text === "—" ? "" : text;
}

function getActiveColFilters() {
  return [...pricingTable.querySelectorAll("thead .col-filter")]
    .map((input) => ({
      input,
      col: input.dataset.filterCol,
      q: String(input.value || "").trim().toLowerCase(),
    }))
    .filter((f) => f.col && f.q);
}

function updateFilterStatus(visible, total) {
  const colFilters = getActiveColFilters();
  const hasCol = colFilters.length > 0;
  const hasSummary = Boolean(summaryFilter);
  const active = hasCol || hasSummary;

  pricingTable.querySelectorAll("thead .col-filter").forEach((input) => {
    const on = String(input.value || "").trim() !== "";
    input.classList.toggle("is-active", on);
    input.closest("th")?.classList.toggle("is-filter-active", on);
  });
  filterRow?.classList.toggle("is-filtering", active);
  pricingWrap?.classList.toggle("is-filtering", active);

  if (!filterStatusEl) return;
  if (!active) {
    filterStatusEl.hidden = true;
    return;
  }

  const parts = [];
  if (hasSummary) {
    parts.push(`grup: ${SUMMARY_LABELS[summaryFilter] || summaryFilter}`);
  }
  if (hasCol) {
    parts.push(`${colFilters.length} coloan${colFilters.length === 1 ? "ă" : "e"}`);
  }
  filterStatusText.textContent = `Filtru activ (${parts.join(", ")}) — ${visible} din ${total} rânduri`;
  filterStatusEl.hidden = false;
}

function clearAllFilters() {
  pricingTable.querySelectorAll("thead .col-filter").forEach((input) => {
    input.value = "";
  });
  summaryFilter = null;
  applySummaryFilter();
}

function filterEmptyMessage() {
  if (summaryFilter === "only_remote") {
    return "Doar pe marketplace — nu apar în tabelul local de prețuri.";
  }
  if (summaryFilter === "only_local") {
    return "Niciun produs „doar local” în tabel.";
  }
  if (summaryFilter === "unlinked") {
    return "Niciun produs nelegat în tabel.";
  }
  if (summaryFilter === "diff") {
    return "Nicio diferență față de marketplace.";
  }
  if (summaryFilter === "matched") {
    return "Niciun produs comun.";
  }
  return "Niciun rând nu potrivește filtrul.";
}

function applyPricingFilters() {
  const filters = getActiveColFilters();

  const bucketIds =
    summaryFilter && summaryFilter !== "only_remote"
      ? bucketOfferIds(summaryFilter)
      : null;

  const rows = [...pricingBody.querySelectorAll("tr[data-offer-id]")];
  let visible = 0;

  rows.forEach((tr) => {
    let match =
      filters.length === 0 ||
      filters.every((f) => pricingCellText(tr, f.col).toLowerCase().includes(f.q));
    if (summaryFilter === "diff") {
      match = match && tr.classList.contains("has-diff");
    } else if (summaryFilter === "only_remote") {
      // Ofertă doar pe marketplace — nu e în catalogul local / tabelul de prețuri.
      match = false;
    } else if (bucketIds) {
      match = match && bucketIds.has(String(tr.dataset.offerId));
    }
    tr.classList.toggle("is-row-filtered", !match);
    if (match) visible += 1;
  });

  let emptyRow = pricingBody.querySelector("tr.filter-empty-row");
  const filtering = filters.length > 0 || Boolean(summaryFilter);
  if (filtering && rows.length > 0 && visible === 0) {
    if (!emptyRow) {
      emptyRow = document.createElement("tr");
      emptyRow.className = "empty-row filter-empty-row";
      emptyRow.innerHTML = `<td colspan="${PRICING_COL_COUNT}"></td>`;
      pricingBody.appendChild(emptyRow);
    }
    emptyRow.querySelector("td").textContent = filterEmptyMessage();
    emptyRow.hidden = false;
  } else if (emptyRow) {
    emptyRow.hidden = true;
  }

  updateFilterStatus(visible, rows.length);
}

const NUMERIC_PRICING_COLS = new Set([
  "index",
  "id",
  "id_familie",
  "pret_cumparare",
  "alte_costuri",
  "pret_emag",
  "prp",
  "pret_minim",
  "pret_maxim",
  "stoc",
  "procentaj_emag",
  "pret_minim_profit",
  "profit",
  "procentaj_profit",
]);

function sortPricingTable() {
  pricingTable.querySelectorAll("thead tr:not(.filter-row) th[data-col]").forEach((th) => {
    th.classList.remove("is-sorted-asc", "is-sorted-desc");
    if (pricingSortCol && th.dataset.col === pricingSortCol) {
      th.classList.add(pricingSortDir === "asc" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", pricingSortDir === "asc" ? "ascending" : "descending");
    } else {
      th.setAttribute("aria-sort", "none");
    }
  });
  if (!pricingSortCol) return;

  const numeric = NUMERIC_PRICING_COLS.has(pricingSortCol);
  const rows = [...pricingBody.querySelectorAll("tr[data-offer-id]")];
  rows.sort((a, b) => {
    const ra = pricingCellText(a, pricingSortCol);
    const rb = pricingCellText(b, pricingSortCol);
    const va = numeric ? parseSortNumber(ra) : ra.toLowerCase();
    const vb = numeric ? parseSortNumber(rb) : rb.toLowerCase();
    const aEmpty = va == null || va === "";
    const bEmpty = vb == null || vb === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return pricingSortDir === "asc" ? 1 : -1;
    if (bEmpty) return pricingSortDir === "asc" ? -1 : 1;
    const cmp =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb), "ro", { numeric: true, sensitivity: "base" });
    return pricingSortDir === "asc" ? cmp : -cmp;
  });
  rows.forEach((tr, i) => {
    pricingBody.appendChild(tr);
    const indexCell = tr.querySelector("td[data-col='index']");
    if (indexCell) indexCell.textContent = String(i + 1);
  });
}

pricingTable.querySelector("thead")?.addEventListener("click", (e) => {
  if (e.target.closest(".filter-row") || e.target.closest(".col-filter")) return;
  const th = e.target.closest("thead tr:not(.filter-row) th[data-col]");
  if (!th) return;
  const col = th.dataset.col;
  if (pricingSortCol === col) {
    pricingSortDir = pricingSortDir === "asc" ? "desc" : "asc";
  } else {
    pricingSortCol = col;
    pricingSortDir = "asc";
  }
  sortPricingTable();
});

let pricingFilterTimer = null;
filterRow?.addEventListener("input", (e) => {
  if (!e.target.closest(".col-filter")) return;
  clearTimeout(pricingFilterTimer);
  pricingFilterTimer = setTimeout(applyPricingFilters, 150);
});

btnClearFilters?.addEventListener("click", clearAllFilters);

/* ---------- publicare pe canal ---------- */

const PUSH_PRICE_KEYS = new Set([
  "sale_price",
  "recommended_price",
  "min_sale_price",
  "max_sale_price",
  "general_stock",
]);

/** Trimite ofertele care difera fata de ultima preluare; catalogul e sursa prețurilor. */
async function pushToChannel() {
  if (pushing) return;
  if (warnIfChannelUnconfigured()) return;
  if (!currentData) {
    setStatus("Încarcă întâi comparația.", "error");
    return;
  }
  const ids = currentData.matched
    .filter((m) => m.fields.some((f) => f.differs && PUSH_PRICE_KEYS.has(f.key)))
    .map((m) => m.external_id);
  if (ids.length === 0) {
    setStatus("Nimic de publicat — nicio diferență de preț sau stoc.", "ok");
    return;
  }

  pushing = true;
  btnPush.disabled = true;
  setStatus(`Se publică ${ids.length} oferte…`, "loading");
  try {
    const res = await fetch(
      `/api/products/sync-prices?channel=${encodeURIComponent(currentChannel)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offers: ids.map((id) => ({ id })),
          includeContent: false,
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      showApiError(data, `HTTP ${res.status}`);
      return;
    }
    if (syncInfoBanner) syncInfoBanner.hidden = false;
    await Promise.all([loadDiff(), loadPricing()]);
    setStatus(
      `Trimise ${ids.length} oferte pe ${currentChannel}. Apasă „Preia de la marketplace” peste 5-10 min ca să confirmi.`,
      "ok"
    );
  } catch (err) {
    setStatus(err.message || "Eroare la publicare", "error");
  } finally {
    pushing = false;
    btnPush.disabled = false;
  }
}

/* ---------- compactare + fullscreen ---------- */

function setCompact(wrap, btn, on, storageKey) {
  if (!wrap || !btn) return;
  wrap.classList.toggle("is-compact", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.textContent = on ? "Normal" : "Compact";
  try {
    localStorage.setItem(storageKey, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function setTableFullscreen(on) {
  if (!pageEl || !btnTableFullscreen) return;
  pageEl.classList.toggle("is-table-fullscreen", on);
  btnTableFullscreen.setAttribute("aria-pressed", on ? "true" : "false");
  btnTableFullscreen.title = on ? "Ieși din toată pagina" : "Tabel pe toată pagina";
  const label = btnTableFullscreen.querySelector(".btn-fullscreen-label");
  if (label) label.textContent = on ? "Micșorează" : "Toată pagina";
  const path = btnTableFullscreen.querySelector("svg path");
  if (path) {
    path.setAttribute(
      "d",
      on
        ? "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"
        : "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"
    );
  }
  try {
    localStorage.setItem(TABLE_FULLSCREEN_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function initCompactToggle() {
  let pricingOn = false;
  try {
    pricingOn = localStorage.getItem(COMPACT_PRICING_KEY) === "1";
  } catch {
    /* ignore */
  }
  setCompact(pricingWrap, btnCompactPricing, pricingOn, COMPACT_PRICING_KEY);
  btnCompactPricing?.addEventListener("click", () => {
    const next = !pricingWrap.classList.contains("is-compact");
    setCompact(pricingWrap, btnCompactPricing, next, COMPACT_PRICING_KEY);
  });
}

function initFullscreenToggle() {
  btnTableFullscreen?.addEventListener("click", () => {
    setTableFullscreen(!pageEl.classList.contains("is-table-fullscreen"));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pageEl?.classList.contains("is-table-fullscreen")) {
      setTableFullscreen(false);
    }
  });
  try {
    if (localStorage.getItem(TABLE_FULLSCREEN_KEY) === "1") {
      setTableFullscreen(true);
    }
  } catch {
    /* ignore */
  }
}

/* ---------- pornire ---------- */

channelSelect.value = currentChannel;
channelSelect.addEventListener("change", async () => {
  currentChannel = channelSelect.value || "emag";
  summaryFilter = null;
  try {
    localStorage.setItem(CHANNEL_KEY, currentChannel);
  } catch {
    /* ignore */
  }
  if (channelConfiguredMap[currentChannel] === false) clearClientSyncCaches();
  else {
    restorePricingCache();
    restoreDiffCache();
  }
  await loadDiff();
  await loadPricing();
  warnIfChannelUnconfigured();
});
btnPull.addEventListener("click", pullFromChannel);
btnPush.addEventListener("click", pushToChannel);
btnFetchCommission.addEventListener("click", fetchCommission);

summaryEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button.sync-chip[data-filter]");
  if (!btn) return;
  const next = btn.dataset.filter;
  summaryFilter = summaryFilter === next ? null : next;
  applySummaryFilter();
});

columns.applyOrder();
columns.buildMenu();
columns.applyVisibility();
initCompactToggle();
initFullscreenToggle();
cellTextTip = createCellTextTip();

refreshChannelConfigured().then(async () => {
  if (channelConfiguredMap[currentChannel] === false) {
    clearClientSyncCaches();
  } else {
    restorePricingCache();
    restoreDiffCache();
  }
  await loadDiff();
  await loadPricing();
  warnIfChannelUnconfigured();
});
