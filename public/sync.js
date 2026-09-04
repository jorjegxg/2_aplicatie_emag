/* Comparatie: valorile mele din DB vs ultimul snapshot al marketplace-ului. Doar citire. */

const CHANNEL_KEY = "marketplace-channel";
const PRICING_CACHE_KEY = "sync-pricing-cache-v1";
const DIFF_CACHE_KEY = "sync-diff-cache-v1";

const channelSelect = document.getElementById("channel-select");
const btnPull = document.getElementById("btn-pull");
const btnFetchCommission = document.getElementById("btn-fetch-commission");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("sync-summary");
const diffHead = document.getElementById("diff-head");
const diffBody = document.getElementById("diff-body");
const onlyRemoteBody = document.getElementById("only-remote-body");
const onlyLocalBody = document.getElementById("only-local-body");
const unlinkedBody = document.getElementById("unlinked-body");

let currentChannel = localStorage.getItem(CHANNEL_KEY) || "emag";
let currentData = null;
let loading = false;
let pulling = false;
let fetchingCommission = false;
/** null | matched | diff | only_remote | only_local | unlinked */
let summaryFilter = null;

const STATUS_LABELS = { 0: "Inactiv", 1: "Activ", 2: "În așteptare" };

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

function formatStamp(iso) {
  if (!iso) return "niciodată";
  try {
    return new Date(iso).toLocaleString("ro-RO");
  } catch {
    return String(iso);
  }
}

function formatValue(key, value) {
  if (value == null || value === "") return "—";
  if (key === "status") return STATUS_LABELS[Number(value)] ?? String(value);
  if (key === "name") return String(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return key === "general_stock" ? String(n) : n.toFixed(2);
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

function scrollToSummarySection(filter) {
  const map = {
    matched: "diff-wrap",
    diff: "pricing-wrap",
    only_remote: "only-remote-body",
    only_local: "only-local-body",
    unlinked: "unlinked-body",
  };
  const id = map[filter];
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;
  const target = el.closest(".table-wrap") || el;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

function applySummaryFilter() {
  summaryEl.querySelectorAll("button.sync-chip[data-filter]").forEach((btn) => {
    const on = btn.dataset.filter === summaryFilter;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  if (currentData) renderDiffRows(currentData);
  applyPricingFilters();
  if (summaryFilter) scrollToSummarySection(summaryFilter);
}

function renderHead(fields) {
  diffHead.innerHTML = `
    <tr>
      <th rowspan="2">ID ofertă</th>
      <th rowspan="2">SKU</th>
      ${fields.map((f) => `<th colspan="2">${escapeHtml(f.label)}</th>`).join("")}
    </tr>
    <tr>
      ${fields
        .map(
          () =>
            `<th class="sync-sub sync-mine">Al meu</th><th class="sync-sub sync-theirs">Marketplace</th>`
        )
        .join("")}
    </tr>
  `;
}

function renderDiffRows(data) {
  let rows = data.matched;
  if (summaryFilter === "diff") {
    rows = rows.filter((m) => m.diff_count > 0);
  } else if (
    summaryFilter === "only_remote" ||
    summaryFilter === "only_local" ||
    summaryFilter === "unlinked"
  ) {
    rows = [];
  }
  const cols = data.fields.length * 2 + 2;

  if (rows.length === 0) {
    const emptyMsg =
      summaryFilter === "diff"
        ? "Nicio diferență."
        : summaryFilter
          ? "—"
          : "Niciun produs comun.";
    diffBody.innerHTML = `<tr class="empty-row"><td colspan="${cols}">${emptyMsg}</td></tr>`;
    return;
  }

  diffBody.innerHTML = rows
    .map((row) => {
      const cells = row.fields
        .map((f) => {
          const mineText = formatValue(f.key, f.mine);
          const theirsText = formatValue(f.key, f.theirs);
          return `<td class="sync-mine${f.differs ? " is-diff" : ""}"${titleAttr(
            mineText
          )}>${escapeHtml(mineText)}</td><td class="sync-theirs${
            f.differs ? " is-diff" : ""
          }"${titleAttr(theirsText)}>${escapeHtml(theirsText)}</td>`;
        })
        .join("");
      return `<tr class="${row.diff_count > 0 ? "has-diff" : ""}">
        <td${titleAttr(row.external_id)}>${escapeHtml(row.external_id)}</td>
        <td${titleAttr(row.part_number || "—")}>${escapeHtml(row.part_number || "—")}</td>
        ${cells}
      </tr>`;
    })
    .join("");
}

function renderSimpleRows(tbody, items, cols) {
  if (!items.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${cols}">—</td></tr>`;
    return;
  }
  tbody.innerHTML = items
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.external_id)}</td>
        <td>${escapeHtml(r.part_number || "—")}</td>
        <td>${escapeHtml(r.name || "—")}</td>
        ${cols > 3 ? `<td>${escapeHtml(formatValue("sale_price", r.sale_price))}</td>` : ""}
        ${cols > 3 ? `<td>${escapeHtml(formatValue("general_stock", r.general_stock))}</td>` : ""}
      </tr>`
    )
    .join("");
}

function render(data) {
  renderSummary(data);
  renderHead(data.fields);
  renderDiffRows(data);
  renderSimpleRows(onlyRemoteBody, data.only_remote, 5);
  renderSimpleRows(onlyLocalBody, data.only_local, 5);
  renderSimpleRows(unlinkedBody, data.unlinked, 3);
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

function restoreDiffCache() {
  const cached = readDiffCache();
  if (!cached) return false;
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
    diffBody.innerHTML = `<tr class="empty-row"><td colspan="16">${escapeHtml(
      err.message || "Eroare"
    )}</td></tr>`;
  } finally {
    loading = false;
  }
}

async function pullFromChannel() {
  if (pulling) return;
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
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setStatus(
      `Preluate ${data.count} oferte (${data.created} noi, ${data.updated} actualizate).`,
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
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

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

/* ================= Preturi si marja (tabelul de sus) ================= */

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
const COMPACT_DIFF_KEY = "sync-compact-diff";

const pricingTable = document.getElementById("pricing-table");
const pricingBody = document.getElementById("pricing-body");
const pricingWrap = document.getElementById("pricing-wrap");
const diffWrap = document.getElementById("diff-wrap");
const thPretCanal = document.getElementById("th-pret-canal");
const btnPush = document.getElementById("btn-push");
const btnCompactPricing = document.getElementById("btn-compact-pricing");
const btnCompactDiff = document.getElementById("btn-compact-diff");
const syncInfoBanner = document.getElementById("sync-info-banner");

function diffKeysForOffer(offerId) {
  const keys = new Set();
  if (!currentData || !Array.isArray(currentData.matched)) return keys;
  const row = currentData.matched.find((m) => String(m.external_id) === String(offerId));
  if (!row) return keys;
  for (const f of row.fields || []) {
    if (f.differs) keys.add(f.key);
  }
  return keys;
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

  // Coloanele preluate din pagina de produse sunt doar afisate aici.
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
    )}${titleAttr(pretEmagText)}>${pretEmagText}</td>`,
    prp: `<td data-col="prp"${cellClass("prp")}${titleAttr(prpText)}>${prpText}</td>`,
    pret_minim: `<td data-col="pret_minim"${cellClass("pret_minim")}${titleAttr(
      pretMinimText
    )}>${pretMinimText}</td>`,
    pret_maxim: `<td data-col="pret_maxim"${cellClass("pret_maxim")}${titleAttr(
      pretMaximText
    )}>${pretMaximText}</td>`,
    stoc: `<td data-col="stoc"${cellClass("stoc")}${titleAttr(stocText)}>${escapeHtml(
      stoc
    )}</td>`,
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
    // Păstrează is-col-hidden / ordine din columns — doar text, fără pct-1/pct-2.
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
  if (!resetBtn) return;
  const tr = resetBtn.closest("tr[data-offer-id]");
  const product = findProduct(tr?.dataset.offerId);
  if (!product) return;
  const input = tr.querySelector("input.input-procentaj-emag");
  if (input) input.value = String(DEFAULT_PROcentaj_EMAG);
  product.procentaj_emag = null;
  syncCommissionCell(tr);
  refreshPricingRow(tr, product);
  schedulePersistListing(product.id, { procentaj_emag: null }, "procentaj-emag");
});

/* ---------- filtrare + sortare ---------- */

function pricingCellText(tr, col) {
  const td = tr.querySelector(`td[data-col="${col}"]`);
  if (!td) return "";
  const input = td.querySelector("input");
  if (input) return String(input.value ?? "").trim();
  const text = (td.textContent || "").trim();
  return !text || text === "—" ? "" : text;
}

function applyPricingFilters() {
  const filters = [...pricingTable.querySelectorAll("thead .col-filter")]
    .map((input) => ({
      col: input.dataset.filterCol,
      q: String(input.value || "").trim().toLowerCase(),
    }))
    .filter((f) => f.col && f.q);

  const bucketIds =
    summaryFilter && summaryFilter !== "only_remote"
      ? bucketOfferIds(summaryFilter)
      : null;

  pricingBody.querySelectorAll("tr[data-offer-id]").forEach((tr) => {
    let match =
      filters.length === 0 ||
      filters.every((f) => pricingCellText(tr, f.col).toLowerCase().includes(f.q));
    if (summaryFilter === "diff") {
      match = match && tr.classList.contains("has-diff");
    } else if (summaryFilter === "only_remote") {
      match = false;
    } else if (bucketIds) {
      match = match && bucketIds.has(String(tr.dataset.offerId));
    }
    tr.classList.toggle("is-row-filtered", !match);
  });
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
pricingTable.querySelector("thead tr.filter-row")?.addEventListener("input", (e) => {
  if (!e.target.closest(".col-filter")) return;
  clearTimeout(pricingFilterTimer);
  pricingFilterTimer = setTimeout(applyPricingFilters, 150);
});

/* ---------- publicare pe canal ---------- */

/* Push doar pret + stoc + PRP/min/max — fara nume/descriere. */
const PUSH_PRICE_KEYS = new Set([
  "sale_price",
  "recommended_price",
  "min_sale_price",
  "max_sale_price",
  "general_stock",
]);

/** Trimite ofertele care difera fata de ultima preluare; DB-ul e sursa valorilor. */
async function pushToChannel() {
  if (pushing) return;
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
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (syncInfoBanner) syncInfoBanner.hidden = false;
    // Snapshot-ul nu se mai actualizeaza la push: diferentele raman pana la urmatorul pull.
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

/* ---------- compactare tabele ---------- */

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

function initCompactToggles() {
  let pricingOn = false;
  let diffOn = false;
  try {
    pricingOn = localStorage.getItem(COMPACT_PRICING_KEY) === "1";
    diffOn = localStorage.getItem(COMPACT_DIFF_KEY) === "1";
  } catch {
    /* ignore */
  }
  setCompact(pricingWrap, btnCompactPricing, pricingOn, COMPACT_PRICING_KEY);
  setCompact(diffWrap, btnCompactDiff, diffOn, COMPACT_DIFF_KEY);

  btnCompactPricing?.addEventListener("click", () => {
    const next = !pricingWrap.classList.contains("is-compact");
    setCompact(pricingWrap, btnCompactPricing, next, COMPACT_PRICING_KEY);
  });
  btnCompactDiff?.addEventListener("click", () => {
    const next = !diffWrap.classList.contains("is-compact");
    setCompact(diffWrap, btnCompactDiff, next, COMPACT_DIFF_KEY);
  });
}

/* ---------- pornire ---------- */

channelSelect.value = currentChannel;
channelSelect.addEventListener("change", () => {
  currentChannel = channelSelect.value || "emag";
  summaryFilter = null;
  try {
    localStorage.setItem(CHANNEL_KEY, currentChannel);
  } catch {
    /* ignore */
  }
  restorePricingCache();
  restoreDiffCache();
  loadDiff();
  loadPricing();
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
initCompactToggles();

restorePricingCache();
restoreDiffCache();
loadDiff();
loadPricing();
