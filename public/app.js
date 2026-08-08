const btnLoad = document.getElementById("btn-load");
const btnMore = document.getElementById("btn-more");
const btnSaveSettings = document.getElementById("btn-save-settings");
const btnSync = document.getElementById("btn-sync");
const btnColumns = document.getElementById("btn-columns");
const btnTableFullscreen = document.getElementById("btn-table-fullscreen");
const colMenu = document.getElementById("col-menu");
const statusEl = document.getElementById("status");
const syncInfoBanner = document.getElementById("sync-info-banner");
const tbody = document.getElementById("products-body");
const table = document.getElementById("products-table");
const pageEl = document.querySelector(".page");
const inputProcentaj = document.getElementById("procentaj-emag");
const inputProcentajAlte = document.getElementById("procentaj-alte-costuri");
const inputMultPrp = document.getElementById("mult-prp");
const inputMultMin = document.getElementById("mult-min");
const inputMultMax = document.getElementById("mult-max");
const inputTotalAlteStoc = document.getElementById("total-alte-stoc");
const inputTotalProfitStoc = document.getElementById("total-profit-stoc");

const HIDDEN_COLS_KEY = "emag-hidden-columns";
const COL_ORDER_KEY = "emag-column-order";
const TABLE_FULLSCREEN_KEY = "emag-table-fullscreen";
const PRODUCTS_CACHE_KEY = "emag-products-cache-v2";
const DEFAULT_ALTE_COSTURI = 0;

const headerLabelRow = table.querySelector("thead tr:not(.filter-row)");
const DEFAULT_COLUMN_ORDER = [
  ...headerLabelRow.querySelectorAll("th[data-col]"),
].map((th) => th.dataset.col);
const COLUMN_LABELS = Object.fromEntries(
  [...headerLabelRow.querySelectorAll("th[data-col]")].map((th) => [
    th.dataset.col,
    th.textContent.trim(),
  ])
);
const COLUMN_SOURCES = Object.fromEntries(
  [...headerLabelRow.querySelectorAll("th[data-col]")].map((th) => [
    th.dataset.col,
    th.dataset.src || "",
  ])
);

let currentPage = 1;
let hasMore = false;
/** @type {Array<object>} */
let loadedProducts = [];
let loading = false;
let savingSettings = false;
let syncing = false;
let hiddenCols = loadHiddenCols();
let columnOrder = loadColumnOrder();
let dragCol = null;
let savedSettingsSnapshot = null;
let sortCol = null;
let sortDir = "asc";

function migrateLegacyCostCols(cols) {
  const OLD = new Set([
    "pret_transport",
    "pret_contabil",
    "procentaj_alte_costuri",
  ]);
  const out = [];
  let insertedAlte = false;
  for (const c of cols) {
    if (c === "pret_transport" || c === "pret_contabil") {
      if (!insertedAlte) {
        out.push("alte_costuri");
        insertedAlte = true;
      }
      continue;
    }
    if (OLD.has(c)) continue;
    out.push(c);
  }
  return out;
}

function loadHiddenCols() {
  try {
    const raw = localStorage.getItem(HIDDEN_COLS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return migrateLegacyCostCols(parsed.filter((c) => typeof c === "string"));
  } catch {
    return [];
  }
}

function saveHiddenCols() {
  localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify(hiddenCols));
}

function insertMissingColumns(order) {
  const result = [...order];
  for (const col of DEFAULT_COLUMN_ORDER) {
    if (result.includes(col)) continue;
    const defIdx = DEFAULT_COLUMN_ORDER.indexOf(col);
    let insertAt = result.length;
    for (let i = defIdx - 1; i >= 0; i--) {
      const prevIdx = result.indexOf(DEFAULT_COLUMN_ORDER[i]);
      if (prevIdx !== -1) {
        insertAt = prevIdx + 1;
        break;
      }
    }
    result.splice(insertAt, 0, col);
  }
  return result;
}

function loadColumnOrder() {
  try {
    const raw = localStorage.getItem(COL_ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [...DEFAULT_COLUMN_ORDER];
    const migrated = migrateLegacyCostCols(
      parsed.filter((c) => typeof c === "string")
    );
    const valid = new Set(DEFAULT_COLUMN_ORDER);
    return insertMissingColumns(migrated.filter((c) => valid.has(c)));
  } catch {
    return [...DEFAULT_COLUMN_ORDER];
  }
}

function saveColumnOrder() {
  localStorage.setItem(COL_ORDER_KEY, JSON.stringify(columnOrder));
}

function applyColumnVisibility() {
  const hidden = new Set(hiddenCols);
  table.querySelectorAll("[data-col]").forEach((el) => {
    el.classList.toggle("is-col-hidden", hidden.has(el.dataset.col));
  });
}

function reorderRowByColumnOrder(row) {
  if (!row) return;
  const byCol = Object.fromEntries(
    [...row.querySelectorAll("[data-col]")].map((el) => [el.dataset.col, el])
  );
  columnOrder.forEach((col) => {
    if (byCol[col]) row.appendChild(byCol[col]);
  });
}

function applyColumnOrder() {
  reorderRowByColumnOrder(table.querySelector("thead tr:not(.filter-row)"));
  reorderRowByColumnOrder(table.querySelector("thead tr.filter-row"));

  tbody.querySelectorAll("tr:not(.empty-row)").forEach((tr) => {
    reorderRowByColumnOrder(tr);
  });
}

function buildColumnMenu() {
  colMenu.innerHTML = columnOrder
    .map((col) => {
      const checked = !hiddenCols.includes(col) ? "checked" : "";
      const label = COLUMN_LABELS[col] || col;
      const src = COLUMN_SOURCES[col] || "";
      const srcAttr = src ? ` data-src="${escapeHtml(src)}"` : "";
      return `<div class="col-menu-item"${srcAttr} data-col="${escapeHtml(col)}">
        <span class="col-drag-handle" draggable="true" aria-hidden="true" title="Trage pentru a reordona">⋮⋮</span>
        <label><input type="checkbox" data-col-toggle="${escapeHtml(col)}" ${checked} />${escapeHtml(label)}</label>
      </div>`;
    })
    .join("");
}

function setColumnMenuOpen(open) {
  colMenu.hidden = !open;
  btnColumns.setAttribute("aria-expanded", open ? "true" : "false");
}

function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (type ? ` is-${type}` : "");
}

function fillSettings(settings) {
  inputProcentaj.value =
    settings.procentaj_emag != null ? settings.procentaj_emag : "";
  inputProcentajAlte.value =
    settings.procentaj_alte_costuri != null
      ? settings.procentaj_alte_costuri
      : "";
  inputMultPrp.value = settings.mult_prp != null ? settings.mult_prp : "";
  inputMultMin.value = settings.mult_min != null ? settings.mult_min : "";
  inputMultMax.value = settings.mult_max != null ? settings.mult_max : "";
  snapshotSettings();
}

function readSettingsFromForm() {
  return {
    procentaj_emag: inputProcentaj.value,
    procentaj_alte_costuri: inputProcentajAlte.value,
    mult_prp: inputMultPrp.value,
    mult_min: inputMultMin.value,
    mult_max: inputMultMax.value,
  };
}

function snapshotSettings() {
  savedSettingsSnapshot = readSettingsFromForm();
  updateSaveDirtyState();
}

function isSettingsDirty() {
  if (!savedSettingsSnapshot) return false;
  const current = readSettingsFromForm();
  return Object.keys(current).some(
    (key) => String(current[key]) !== String(savedSettingsSnapshot[key])
  );
}

function updateSaveDirtyState() {
  const dirty = isSettingsDirty();
  btnSaveSettings.classList.toggle("is-dirty", dirty);
  btnSaveSettings.disabled = savingSettings || !dirty;
}

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Eroare HTTP ${res.status}`);
    fillSettings(data);
    updateDerivedCells();
  } catch (err) {
    setStatus(err.message || "Eroare la încărcare setări", "error");
  }
}

async function saveSettings() {
  if (savingSettings || !isSettingsDirty()) return;
  savingSettings = true;
  updateSaveDirtyState();
  setStatus("Se salvează…", "loading");

  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(readSettingsFromForm()),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Eroare HTTP ${res.status}`);
    fillSettings(data);
    updateDerivedCells();
    setStatus("Setări salvate.", "ok");
  } catch (err) {
    setStatus(err.message || "Eroare la salvare", "error");
  } finally {
    savingSettings = false;
    updateSaveDirtyState();
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPrice(price, currency) {
  if (price == null || price === "") return "—";
  const num = Number(price);
  if (Number.isNaN(num)) return escapeHtml(price);
  return `${num.toFixed(2)} ${escapeHtml(currency || "RON")}`;
}

function formatPercent(value) {
  if (value == null || value === "") return "—";
  const num = Number(value);
  if (Number.isNaN(num)) return "—";
  return `${num.toFixed(2)}%`;
}

const PCT_LEVEL_CLASSES = ["pct-1", "pct-2", "pct-3"];

function procentajLevelClass(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  // Match displayed toFixed(2) so 19.996 → "20.00" gets the same color
  const shown = Math.round(n * 100) / 100;
  if (shown < 20) return "pct-1";
  return "pct-2";
}

function fillProcentajCell(cell, value) {
  cell.classList.remove(...PCT_LEVEL_CLASSES);
  const level = procentajLevelClass(value);
  if (level) cell.classList.add(level);
  const input = cell.querySelector("input.input-procentaj-profit");
  if (input) {
    if (document.activeElement === input) return;
    input.value =
      value == null || value === "" || !Number.isFinite(Number(value))
        ? ""
        : Number(value).toFixed(2);
    return;
  }
  cell.innerHTML = formatPercent(value);
}

function roundPrice(n) {
  return Math.round(n * 10000) / 10000;
}

function parseMult(inputEl) {
  if (inputEl.value === "") return null;
  const n = Number(inputEl.value);
  return Number.isFinite(n) ? n : null;
}

function derivePrices(salePrice) {
  const sale = Number(salePrice);
  if (!Number.isFinite(sale)) {
    return { prp: null, min: null, max: null };
  }
  const mPrp = parseMult(inputMultPrp);
  const mMin = parseMult(inputMultMin);
  const mMax = parseMult(inputMultMax);
  return {
    prp: mPrp != null ? roundPrice(sale * mPrp) : null,
    min: mMin != null ? roundPrice(sale * mMin) : null,
    max: mMax != null ? roundPrice(sale * mMax) : null,
  };
}

function parseAlteCosturi(raw) {
  if (raw == null || raw === "") return DEFAULT_ALTE_COSTURI;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_ALTE_COSTURI;
}

function getGlobalProcentajAlte() {
  const raw = inputProcentajAlte?.value;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function getRowAlteCosturi(tr) {
  if (hasAlteOverride(tr)) {
    return parseAlteCosturi(tr.dataset.alteOverride);
  }
  const pct = getGlobalProcentajAlte();
  if (pct == null) return DEFAULT_ALTE_COSTURI;
  return alteFromProcentaj(pct, tr?.dataset?.pretCumparare ?? "");
}

function hasAlteOverride(tr) {
  return tr?.dataset?.alteOverride != null && tr.dataset.alteOverride !== "";
}

function syncAlteCosturiCell(tr, alteCosturi) {
  const alteCell = tr.querySelector("td[data-col='alte_costuri']");
  if (!alteCell) return;
  const input = alteCell.querySelector("input.input-alte-costuri");
  const resetBtn = alteCell.querySelector("button.btn-reset-alte");
  const overridden = hasAlteOverride(tr);
  if (input && !overridden) {
    input.value =
      alteCosturi == null || !Number.isFinite(Number(alteCosturi))
        ? ""
        : String(alteCosturi);
  }
  if (resetBtn) resetBtn.hidden = !overridden;
  alteCell.classList.toggle("is-alte-override", overridden);
}

function alteFromProcentaj(procentaj, pretCumparare) {
  const buy = Number(pretCumparare);
  const pct = Number(procentaj);
  if (!Number.isFinite(buy) || buy <= 0 || !Number.isFinite(pct)) {
    return DEFAULT_ALTE_COSTURI;
  }
  return Math.round(buy * (pct / 100) * 100) / 100;
}

function stockSumFromArr(stock) {
  if (!Array.isArray(stock) || !stock.length) return 0;
  return stock.reduce((sum, x) => sum + (Number(x.value) || 0), 0);
}

function getRowStock(tr) {
  const input = tr?.querySelector("input.input-stock");
  if (input && input.value !== "") {
    const n = Number(input.value);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  const stock = parseJsonAttr(tr?.dataset?.stock, []);
  return stockSumFromArr(stock);
}

function setRowStock(tr, qty) {
  const n = Number(qty);
  const value = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const prev = parseJsonAttr(tr.dataset.stock, [{ warehouse_id: 1, value: 0 }]);
  const warehouse_id = Number(prev[0]?.warehouse_id) || 1;
  tr.dataset.stock = JSON.stringify([{ warehouse_id, value }]);
  const input = tr.querySelector("input.input-stock");
  if (input) input.value = String(value);
  return value;
}

function isStockDirty(tr) {
  const original = Number(tr.dataset.originalStock);
  if (!Number.isFinite(original)) return false;
  return getRowStock(tr) !== original;
}

function getRowName(tr) {
  const input = tr?.querySelector("textarea.input-name");
  return String(input?.value ?? "").trim();
}

function autosizeNameTextarea(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function isNameDirty(tr) {
  return getRowName(tr) !== String(tr.dataset.originalName ?? "").trim();
}

const DESC_MAX_HEIGHT_PX = 160;

function getRowDescription(tr) {
  const input = tr?.querySelector("textarea.input-description");
  return String(input?.value ?? "").trim();
}

function autosizeDescriptionTextarea(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, DESC_MAX_HEIGHT_PX)}px`;
}

function isDescriptionDirty(tr) {
  return (
    getRowDescription(tr) !== String(tr.dataset.originalDescription ?? "").trim()
  );
}

function updateTotalAlteStoc() {
  if (!inputTotalAlteStoc) return;
  const rows = tbody.querySelectorAll("tr[data-offer-id]");
  if (!rows.length) {
    inputTotalAlteStoc.value = "—";
    return;
  }
  let total = 0;
  rows.forEach((tr) => {
    total += getRowAlteCosturi(tr) * getRowStock(tr);
  });
  inputTotalAlteStoc.value = total.toFixed(2);
}

function getRowSalePrice(tr) {
  const input = tr?.querySelector("input.input-sale-price");
  if (input && input.value !== "") return input.value;
  return tr?.querySelector("td.col-profit")?.dataset?.salePrice ?? "";
}

function updateTotalProfitStoc() {
  if (!inputTotalProfitStoc) return;
  const rows = tbody.querySelectorAll("tr[data-offer-id]");
  if (!rows.length) {
    inputTotalProfitStoc.value = "—";
    return;
  }
  let total = 0;
  let any = false;
  rows.forEach((tr) => {
    const profit = calcProfit(
      getRowSalePrice(tr),
      tr.dataset.pretCumparare ?? "",
      getRowAlteCosturi(tr)
    );
    if (profit == null || !Number.isFinite(profit)) return;
    total += profit * getRowStock(tr);
    any = true;
  });
  inputTotalProfitStoc.value = any ? total.toFixed(2) : "—";
}

function updateToolbarTotals() {
  updateTotalAlteStoc();
  updateTotalProfitStoc();
}

function calcProfit(salePrice, pretCumparare, alteCosturi = DEFAULT_ALTE_COSTURI) {
  if (salePrice == null || salePrice === "" || inputProcentaj.value === "") {
    return null;
  }
  const sale = Number(salePrice);
  const pct = Number(inputProcentaj.value);
  if (Number.isNaN(sale) || Number.isNaN(pct)) return null;

  const afterEmag = sale * (1 - pct / 100);
  const buy = Number(pretCumparare);
  const buyCost =
    pretCumparare == null || pretCumparare === "" || Number.isNaN(buy) ? 0 : buy;
  const other = parseAlteCosturi(alteCosturi);

  return afterEmag - buyCost - other;
}

function calcProcentajProfit(salePrice, pretCumparare, alteCosturi = DEFAULT_ALTE_COSTURI) {
  const profit = calcProfit(salePrice, pretCumparare, alteCosturi);
  const minProfit = calcPretMinimProfit(pretCumparare, alteCosturi);
  if (profit == null || minProfit == null) return null;
  if (!Number.isFinite(profit) || !Number.isFinite(minProfit) || minProfit === 0) {
    return null;
  }
  return (profit / minProfit) * 100;
}

function saleFromProcentaj(procentaj, pretCumparare, alteCosturi = DEFAULT_ALTE_COSTURI) {
  if (procentaj == null || procentaj === "" || inputProcentaj.value === "") {
    return null;
  }
  const pctTarget = Number(procentaj);
  const pctEmag = Number(inputProcentaj.value);
  if (Number.isNaN(pctTarget) || Number.isNaN(pctEmag) || pctEmag >= 100) {
    return null;
  }

  const factor = 1 - pctEmag / 100;
  if (factor <= 0) return null;

  const minProfit = calcPretMinimProfit(pretCumparare, alteCosturi);
  if (minProfit == null || !Number.isFinite(minProfit)) return null;

  const buy = Number(pretCumparare);
  const buyCost =
    pretCumparare == null || pretCumparare === "" || Number.isNaN(buy) ? 0 : buy;
  const costs = buyCost + parseAlteCosturi(alteCosturi);

  return roundPrice((costs + (pctTarget / 100) * minProfit) / factor);
}

function calcPretMinimProfit(pretCumparare, alteCosturi = DEFAULT_ALTE_COSTURI) {
  if (inputProcentaj.value === "") return null;
  const pct = Number(inputProcentaj.value);
  if (Number.isNaN(pct) || pct >= 100) return null;

  const buy = Number(pretCumparare);
  const buyCost =
    pretCumparare == null || pretCumparare === "" || Number.isNaN(buy) ? 0 : buy;
  const costs = buyCost + parseAlteCosturi(alteCosturi);
  const factor = 1 - pct / 100;
  if (factor <= 0) return null;

  return roundPrice(costs / factor);
}

function pricesEqual(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) {
    return String(a ?? "") === String(b ?? "");
  }
  return Math.abs(na - nb) < 0.00005;
}

function syncMinProfitVsEmag(tr, salePrice, pretCumparare, alteCosturi) {
  const minProfitCell = tr.querySelector("td[data-col='pret_minim_profit']");
  if (!minProfitCell) return;
  const minProfit = calcPretMinimProfit(pretCumparare, alteCosturi);
  const sale = Number(salePrice);
  const below =
    minProfit != null &&
    Number.isFinite(minProfit) &&
    Number.isFinite(sale) &&
    sale < minProfit;
  minProfitCell.classList.toggle("is-below-emag", below);
}

function syncPrpVsEmag(tr, salePrice) {
  const prpCell = tr.querySelector("td[data-col='prp']");
  if (!prpCell) return;
  const prp = Number(prpCell.dataset.value);
  const sale = Number(salePrice);
  const low =
    Number.isFinite(prp) && Number.isFinite(sale) && prp < sale;
  prpCell.classList.toggle("is-prp-low", low);
}

function updateSyncButton() {
  const dirtyCount = tbody.querySelectorAll("tr.is-price-dirty").length;
  btnSync.disabled = syncing || dirtyCount === 0;
}

function applyRowPrices(tr, salePrice, { markDirty = true } = {}) {
  const currency = tr.dataset.currency || "RON";
  const pretCumparare = tr.dataset.pretCumparare ?? "";
  const alteCosturi = getRowAlteCosturi(tr);
  const derived = derivePrices(salePrice);

  const profitCell = tr.querySelector("td.col-profit");
  if (profitCell) {
    profitCell.dataset.salePrice = salePrice ?? "";
    profitCell.innerHTML = formatPrice(
      calcProfit(salePrice, pretCumparare, alteCosturi),
      currency
    );
  }

  const procentajCell = tr.querySelector("td.col-procentaj-profit");
  if (procentajCell) {
    fillProcentajCell(
      procentajCell,
      calcProcentajProfit(salePrice, pretCumparare, alteCosturi)
    );
  }

  const prpCell = tr.querySelector("td[data-col='prp']");
  if (prpCell && derived.prp != null) {
    prpCell.dataset.value = String(derived.prp);
    prpCell.innerHTML = formatPrice(derived.prp, currency);
  }

  const minCell = tr.querySelector("td[data-col='pret_minim']");
  if (minCell && derived.min != null) {
    minCell.dataset.value = String(derived.min);
    minCell.innerHTML = formatPrice(derived.min, currency);
  }

  const maxCell = tr.querySelector("td[data-col='pret_maxim']");
  if (maxCell && derived.max != null) {
    maxCell.dataset.value = String(derived.max);
    maxCell.innerHTML = formatPrice(derived.max, currency);
  }

  const pretCell = tr.querySelector("td.col-pret-emag");
  const stocCell = tr.querySelector("td[data-col='stoc']");
  const nameCell = tr.querySelector("td[data-col='name']");
  const descriptionCell = tr.querySelector("td[data-col='description']");
  syncAlteCosturiCell(tr, alteCosturi);
  const original = tr.dataset.originalSale ?? "";
  const priceDirty =
    markDirty &&
    (!pricesEqual(salePrice, original) ||
      (derived.prp != null && !pricesEqual(derived.prp, tr.dataset.originalPrp)) ||
      (derived.min != null && !pricesEqual(derived.min, tr.dataset.originalMin)) ||
      (derived.max != null && !pricesEqual(derived.max, tr.dataset.originalMax)));
  const stockDirty = markDirty && isStockDirty(tr);
  const nameDirty = markDirty && isNameDirty(tr);
  const descriptionDirty = markDirty && isDescriptionDirty(tr);
  const isDirty = priceDirty || stockDirty || nameDirty || descriptionDirty;
  tr.classList.toggle("is-price-dirty", isDirty);
  if (pretCell) pretCell.classList.toggle("is-price-dirty", priceDirty);
  if (prpCell) prpCell.classList.toggle("is-price-dirty", priceDirty);
  if (minCell) minCell.classList.toggle("is-price-dirty", priceDirty);
  if (maxCell) maxCell.classList.toggle("is-price-dirty", priceDirty);
  if (stocCell) stocCell.classList.toggle("is-price-dirty", stockDirty);
  if (nameCell) nameCell.classList.toggle("is-price-dirty", nameDirty);
  if (descriptionCell) {
    descriptionCell.classList.toggle("is-price-dirty", descriptionDirty);
  }

  if (isDirty) {
    tr.classList.remove("is-just-synced");
    if (priceDirty) {
      if (pretCell) pretCell.classList.remove("is-just-synced");
      if (prpCell) prpCell.classList.remove("is-just-synced");
      if (minCell) minCell.classList.remove("is-just-synced");
      if (maxCell) maxCell.classList.remove("is-just-synced");
    }
    if (stockDirty && stocCell) stocCell.classList.remove("is-just-synced");
    if (nameDirty && nameCell) nameCell.classList.remove("is-just-synced");
    if (descriptionDirty && descriptionCell) {
      descriptionCell.classList.remove("is-just-synced");
    }
  }

  const minProfitCell = tr.querySelector("td[data-col='pret_minim_profit']");
  if (minProfitCell) {
    minProfitCell.innerHTML = formatPrice(
      calcPretMinimProfit(pretCumparare, alteCosturi),
      currency
    );
  }

  syncMinProfitVsEmag(tr, salePrice, pretCumparare, alteCosturi);
  syncPrpVsEmag(tr, salePrice);
  updateSyncButton();
}

function updateDerivedCells() {
  tbody.querySelectorAll("tr[data-offer-id]").forEach((tr) => {
    const input = tr.querySelector("input.input-sale-price");
    if (!input) return;
    applyRowPrices(tr, input.value);
  });
  updateToolbarTotals();
  updateSyncButton();
}

function formatStatus(status) {
  if (status === 1 || status === "1") {
    return '<span class="badge badge-active">Activ</span>';
  }
  if (status === 0 || status === "0") {
    return '<span class="badge badge-inactive">Inactiv</span>';
  }
  return escapeHtml(status ?? "—");
}

function eanPnk(product) {
  const parts = [];
  if (product.ean) parts.push(product.ean);
  if (product.part_number_key) parts.push(product.part_number_key);
  return parts.length ? escapeHtml(parts.join(" · ")) : "—";
}

function formatEmagMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  return messages
    .map((m) => {
      if (typeof m === "string") return m;
      if (m && typeof m === "object") {
        const parts = [m.type, m.message || m.msg || JSON.stringify(m)].filter(Boolean);
        return parts.join(": ");
      }
      return String(m);
    })
    .join(" | ");
}

function parseJsonAttr(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function rowHtml(product, index) {
  const currency = product.currency || "RON";
  const salePrice = product.sale_price ?? "";
  const pretCumparare = product.pret_cumparare ?? "";
  const hidden = new Set(hiddenCols);
  const cellClass = (col, extra = "") => {
    const parts = [extra, hidden.has(col) ? "is-col-hidden" : ""].filter(Boolean);
    return parts.length ? ` class="${parts.join(" ")}"` : "";
  };
  const saleAttr = salePrice === "" || salePrice == null ? "" : Number(salePrice);
  const hasOverride =
    product.alte_costuri != null && Number.isFinite(Number(product.alte_costuri));
  const alte = hasOverride
    ? Number(product.alte_costuri)
    : alteFromProcentaj(getGlobalProcentajAlte() ?? "", pretCumparare);
  const alteInputVal =
    alte == null || !Number.isFinite(Number(alte)) ? "" : Number(alte);
  const minProfit = calcPretMinimProfit(pretCumparare, alte);
  const saleNum = Number(salePrice);
  const minBelowEmag =
    minProfit != null &&
    Number.isFinite(minProfit) &&
    Number.isFinite(saleNum) &&
    saleNum < minProfit;
  const minProfitExtra = minBelowEmag ? "is-below-emag" : "";
  const prpNum = Number(product.recommended_price);
  const prpLow =
    Number.isFinite(prpNum) &&
    Number.isFinite(saleNum) &&
    prpNum < saleNum;
  const prpExtra = prpLow ? "is-prp-low" : "";
  const procentajVal = calcProcentajProfit(
    product.sale_price,
    product.pret_cumparare,
    alte
  );
  const procentajAttr =
    procentajVal == null || !Number.isFinite(Number(procentajVal))
      ? ""
      : Number(procentajVal).toFixed(2);
  const procentajExtra = ["col-procentaj-profit", procentajLevelClass(procentajVal)]
    .filter(Boolean)
    .join(" ");
  const stockArr = product.stock ?? [{ warehouse_id: 1, value: 0 }];
  const stockSum = stockSumFromArr(stockArr);
  const gs = Number(product.general_stock);
  const stockVal = Number.isFinite(gs) ? gs : stockSum;
  const stockJson = escapeHtml(JSON.stringify(stockArr));
  const handlingJson = escapeHtml(
    JSON.stringify(product.handling_time ?? [{ warehouse_id: 1, value: 0 }])
  );
  const cells = {
    index: `<td data-col="index"${cellClass("index")}>${index}</td>`,
    id: `<td data-col="id"${cellClass("id")}>${escapeHtml(product.id)}</td>`,
    name: `<td data-col="name"${cellClass("name", "col-name")}><textarea class="input-name" rows="1">${escapeHtml(product.name || "")}</textarea></td>`,
    description: `<td data-col="description"${cellClass("description", "col-description")}><textarea class="input-description" rows="3">${escapeHtml(product.description || "")}</textarea></td>`,
    part_number: `<td data-col="part_number"${cellClass("part_number")}>${escapeHtml(product.part_number) || "—"}</td>`,
    id_familie: `<td data-col="id_familie"${cellClass("id_familie")}>${escapeHtml(product.id_familie) || "—"}</td>`,
    familie: `<td data-col="familie"${cellClass("familie")}>${escapeHtml(product.familie) || "—"}</td>`,
    pret_cumparare: `<td data-col="pret_cumparare"${cellClass("pret_cumparare")}>${formatPrice(product.pret_cumparare, "RON")}</td>`,
    alte_costuri: `<td data-col="alte_costuri"${cellClass("alte_costuri", hasOverride ? "col-alte-costuri is-alte-override" : "col-alte-costuri")}><div class="alte-costuri-wrap"><input type="number" class="input-alte-costuri" min="0" step="0.01" value="${escapeHtml(alteInputVal)}" /><button type="button" class="btn-reset-alte"${hasOverride ? "" : " hidden"} aria-label="Revine la procentaj">×</button></div></td>`,
    pret_minim_profit: `<td data-col="pret_minim_profit"${cellClass("pret_minim_profit", minProfitExtra)}>${formatPrice(minProfit, currency)}</td>`,
    pret_emag: `<td data-col="pret_emag"${cellClass("pret_emag", "col-pret-emag")}><input type="number" class="input-sale-price" min="0" step="0.01" value="${escapeHtml(saleAttr)}" /></td>`,
    profit: `<td data-col="profit"${cellClass("profit", "col-profit")} data-sale-price="${escapeHtml(salePrice)}" data-pret-cumparare="${escapeHtml(pretCumparare)}" data-currency="${escapeHtml(currency)}">${formatPrice(calcProfit(product.sale_price, product.pret_cumparare, alte), currency)}</td>`,
    procentaj_profit: `<td data-col="procentaj_profit"${cellClass("procentaj_profit", procentajExtra)}><input type="number" class="input-procentaj-profit" step="0.01" value="${escapeHtml(procentajAttr)}" /></td>`,
    prp: `<td data-col="prp"${cellClass("prp", prpExtra)} data-value="${escapeHtml(product.recommended_price ?? "")}">${formatPrice(product.recommended_price, currency)}</td>`,
    pret_minim: `<td data-col="pret_minim"${cellClass("pret_minim")} data-value="${escapeHtml(product.min_sale_price ?? "")}">${formatPrice(product.min_sale_price, currency)}</td>`,
    pret_maxim: `<td data-col="pret_maxim"${cellClass("pret_maxim")} data-value="${escapeHtml(product.max_sale_price ?? "")}">${formatPrice(product.max_sale_price, currency)}</td>`,
    stoc: `<td data-col="stoc"${cellClass("stoc", "col-stoc")}><input type="number" class="input-stock" min="0" step="1" value="${escapeHtml(stockVal)}" /></td>`,
    status: `<td data-col="status"${cellClass("status")}>${formatStatus(product.status)}</td>`,
    ean_pnk: `<td data-col="ean_pnk"${cellClass("ean_pnk")}>${eanPnk(product)}</td>`,
  };
  return `<tr data-offer-id="${escapeHtml(product.id)}" data-original-sale="${escapeHtml(salePrice)}" data-original-stock="${escapeHtml(stockVal)}" data-original-name="${escapeHtml(product.name || "")}" data-original-description="" data-pret-cumparare="${escapeHtml(pretCumparare)}" data-currency="${escapeHtml(currency)}" data-original-prp="${escapeHtml(product.recommended_price ?? "")}" data-original-min="${escapeHtml(product.min_sale_price ?? "")}" data-original-max="${escapeHtml(product.max_sale_price ?? "")}" data-status="${escapeHtml(product.status ?? "")}" data-vat-id="${escapeHtml(product.vat_id ?? "")}" data-stock="${stockJson}" data-handling-time="${handlingJson}"${hasOverride ? ` data-alte-override="${escapeHtml(alteInputVal)}"` : ""}>
    ${columnOrder.map((col) => cells[col] || "").join("")}
  </tr>`;
}

function parseSortNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === "—") return null;
  const cleaned = s.replace(/[^\d.,\-]/g, "").replace(",", ".");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function getCellSortValue(tr, col) {
  const td = tr.querySelector(`td[data-col="${col}"]`);
  if (!td) return null;

  if (col === "pret_emag" || col === "procentaj_profit" || col === "alte_costuri") {
    const input = td.querySelector("input");
    return parseSortNumber(input?.value);
  }
  if (col === "prp" || col === "pret_minim" || col === "pret_maxim") {
    return parseSortNumber(td.dataset.value);
  }
  if (col === "profit") {
    const profit = calcProfit(
      td.dataset.salePrice,
      td.dataset.pretCumparare,
      getRowAlteCosturi(tr)
    );
    return profit == null ? null : Number(profit);
  }
  if (col === "status") {
    return parseSortNumber(tr.dataset.status);
  }
  if (col === "stoc") {
    return getRowStock(tr);
  }
  if (col === "name") {
    const name = getRowName(tr);
    return name ? name.toLowerCase() : null;
  }
  if (col === "description") {
    const description = getRowDescription(tr);
    return description ? description.toLowerCase() : null;
  }
  if (
    col === "index" ||
    col === "id" ||
    col === "pret_cumparare" ||
    col === "pret_minim_profit"
  ) {
    return parseSortNumber(td.textContent);
  }

  const text = (td.textContent || "").trim();
  if (!text || text === "—") return null;
  return text.toLowerCase();
}

function compareRows(a, b, col, dir) {
  const va = getCellSortValue(a, col);
  const vb = getCellSortValue(b, col);
  const aEmpty = va == null || va === "";
  const bEmpty = vb == null || vb === "";

  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return dir === "asc" ? 1 : -1;
  if (bEmpty) return dir === "asc" ? -1 : 1;

  let cmp;
  if (typeof va === "number" && typeof vb === "number") {
    cmp = va - vb;
  } else {
    cmp = String(va).localeCompare(String(vb), "ro", { numeric: true, sensitivity: "base" });
  }
  return dir === "asc" ? cmp : -cmp;
}

function updateSortHeaders() {
  table.querySelectorAll("thead tr:not(.filter-row) th[data-col]").forEach((th) => {
    th.classList.remove("is-sorted-asc", "is-sorted-desc");
    if (sortCol && th.dataset.col === sortCol) {
      th.classList.add(sortDir === "asc" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortDir === "asc" ? "ascending" : "descending");
    } else {
      th.setAttribute("aria-sort", "none");
    }
  });
}

function getCellFilterText(tr, col) {
  const td = tr.querySelector(`td[data-col="${col}"]`);
  if (!td) return "";

  if (
    col === "pret_emag" ||
    col === "procentaj_profit" ||
    col === "alte_costuri" ||
    col === "stoc"
  ) {
    return String(td.querySelector("input")?.value ?? "").trim();
  }
  if (col === "name") {
    return String(td.querySelector("textarea.input-name")?.value ?? "").trim();
  }
  if (col === "description") {
    return String(
      td.querySelector("textarea.input-description")?.value ?? ""
    ).trim();
  }
  if (col === "prp" || col === "pret_minim" || col === "pret_maxim") {
    return String(td.dataset.value ?? "").trim();
  }

  const text = (td.textContent || "").trim();
  if (!text || text === "—") return "";
  return text;
}

function getActiveColumnFilters() {
  return [...table.querySelectorAll("thead .col-filter")]
    .map((input) => ({
      col: input.dataset.filterCol,
      q: String(input.value || "").trim().toLowerCase(),
    }))
    .filter((f) => f.col && f.q);
}

function applyColumnFilters() {
  const filters = getActiveColumnFilters();
  const rows = [...tbody.querySelectorAll("tr[data-offer-id]")];
  let existingEmpty = tbody.querySelector(".empty-row");

  if (rows.length === 0) {
    if (existingEmpty?.dataset.filterEmpty === "1") {
      existingEmpty.remove();
    }
    return;
  }

  if (existingEmpty) {
    existingEmpty.remove();
    existingEmpty = null;
  }

  let visibleCount = 0;
  for (const tr of rows) {
    const match =
      filters.length === 0 ||
      filters.every((f) => getCellFilterText(tr, f.col).toLowerCase().includes(f.q));
    tr.classList.toggle("is-row-filtered", !match);
    if (match) visibleCount += 1;
  }

  if (visibleCount === 0 && filters.length > 0) {
    tbody.insertAdjacentHTML(
      "beforeend",
      '<tr class="empty-row" data-filter-empty="1"><td colspan="19">Niciun rezultat pentru filtre.</td></tr>'
    );
  }
}

let filterDebounceTimer = null;
function scheduleColumnFilters() {
  clearTimeout(filterDebounceTimer);
  filterDebounceTimer = setTimeout(applyColumnFilters, 150);
}

function sortProductsTable() {
  updateSortHeaders();
  if (!sortCol) {
    applyColumnFilters();
    return;
  }

  const rows = [...tbody.querySelectorAll("tr[data-offer-id]")];
  if (rows.length === 0) {
    applyColumnFilters();
    return;
  }

  const filterEmpty = tbody.querySelector('.empty-row[data-filter-empty="1"]');
  if (filterEmpty) filterEmpty.remove();

  rows.sort((a, b) => compareRows(a, b, sortCol, sortDir));
  rows.forEach((tr, i) => {
    tbody.appendChild(tr);
    const indexCell = tr.querySelector('td[data-col="index"]');
    if (indexCell) indexCell.textContent = String(i + 1);
  });
  applyColumnFilters();
}

function saveProductsCache() {
  try {
    const payload = {
      products: loadedProducts,
      page: currentPage,
      hasMore,
      savedAt: new Date().toISOString(),
    };
    sessionStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("cache produse:", err.message);
  }
}

function clearProductsCache() {
  try {
    sessionStorage.removeItem(PRODUCTS_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

function readProductsCache() {
  try {
    const raw = sessionStorage.getItem(PRODUCTS_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.products)) return null;
    return data;
  } catch {
    return null;
  }
}

function restoreProductsCache() {
  const data = readProductsCache();
  if (!data || data.products.length === 0) return false;

  loadedProducts = data.products;
  currentPage = Number(data.page) || 1;
  hasMore = Boolean(data.hasMore);

  renderProducts(loadedProducts, false);
  btnMore.hidden = !hasMore;

  const when = data.savedAt
    ? new Date(data.savedAt).toLocaleString("ro-RO")
    : "";
  setStatus(
    `Cache: ${loadedProducts.length} produse` +
      (when ? ` (din ${when})` : "") +
      " — Reload pentru date noi",
    "ok"
  );
  return true;
}

function renderProducts(products, append) {
  if (!append) {
    tbody.innerHTML = "";
  }

  if (!append && products.length === 0) {
    tbody.innerHTML =
      '<tr class="empty-row"><td colspan="19">Niciun produs găsit.</td></tr>';
    updateSyncButton();
    updateToolbarTotals();
    return;
  }

  const empty = tbody.querySelector(".empty-row");
  if (empty) empty.remove();

  const startIndex = tbody.querySelectorAll("tr[data-offer-id]").length + 1;
  tbody.insertAdjacentHTML(
    "beforeend",
    products
      .map((p, i) => rowHtml(p, startIndex + i))
      .join("")
  );
  const rows = tbody.querySelectorAll("tr[data-offer-id]");
  products.forEach((p, i) => {
    const tr = rows[startIndex - 1 + i];
    if (!tr) return;
    // Descrieri lungi/HTML: set via dataset, nu în atribut HTML (newlines sparg atributul)
    tr.dataset.originalDescription = String(p.description || "");
  });
  tbody
    .querySelectorAll("textarea.input-name")
    .forEach((el) => autosizeNameTextarea(el));
  tbody
    .querySelectorAll("textarea.input-description")
    .forEach((el) => autosizeDescriptionTextarea(el));
  if (sortCol) sortProductsTable();
  else applyColumnFilters();
  updateSyncButton();
  updateToolbarTotals();
}

async function loadProducts({ append = false } = {}) {
  if (loading) return;
  loading = true;
  btnLoad.disabled = true;
  btnMore.disabled = true;
  setStatus("Se încarcă…", "loading");

  try {
    const page = append ? currentPage + 1 : 1;
    const res = await fetch(`/api/products?page=${page}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `Eroare HTTP ${res.status}`);
    }

    const products = Array.isArray(data.products) ? data.products : [];
    currentPage = data.page || page;
    hasMore = Boolean(data.hasMore);

    if (append) {
      loadedProducts = loadedProducts.concat(products);
    } else {
      loadedProducts = products;
    }

    saveProductsCache();
    renderProducts(products, append);

    setStatus(
      `Pagina ${currentPage}: ${products.length} produse` +
        (data.authUsed ? ` (${data.authUsed})` : "") +
        " — cached până la Reload",
      "ok"
    );

    btnMore.hidden = !hasMore;
  } catch (err) {
    setStatus(err.message || "Eroare la încărcare", "error");
    if (!append) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="19">${escapeHtml(
        err.message || "Eroare"
      )}</td></tr>`;
      if (loadedProducts.length === 0) {
        clearProductsCache();
      }
    }
  } finally {
    loading = false;
    btnLoad.disabled = false;
    btnMore.disabled = false;
    updateSyncButton();
  }
}

function collectDirtyOffers() {
  const offers = [];
  const errors = [];
  tbody.querySelectorAll("tr.is-price-dirty").forEach((tr) => {
    const id = Number(tr.dataset.offerId);
    const input = tr.querySelector("input.input-sale-price");
    const sale_price = Number(input?.value);
    if (!Number.isFinite(id) || !Number.isFinite(sale_price)) return;

    const status = Number(tr.dataset.status);
    const vat_id = Number(tr.dataset.vatId);
    if (!Number.isFinite(status) || !Number.isFinite(vat_id)) {
      errors.push(`Oferta ${id}: lipsesc status/vat_id — reîncarcă produsele`);
      return;
    }

    const prp = Number(tr.querySelector("td[data-col='prp']")?.dataset.value);
    const min = Number(tr.querySelector("td[data-col='pret_minim']")?.dataset.value);
    const max = Number(tr.querySelector("td[data-col='pret_maxim']")?.dataset.value);

    if (Number.isFinite(prp) && prp <= sale_price) {
      errors.push(
        `Oferta ${id}: PRP (${prp}) trebuie să fie mai mare decât pretul de vânzare (${sale_price})`
      );
      return;
    }

    const stockQty = getRowStock(tr);
    const prevStock = parseJsonAttr(tr.dataset.stock, [{ warehouse_id: 1, value: 0 }]);
    const warehouse_id = Number(prevStock[0]?.warehouse_id) || 1;
    const stock = [{ warehouse_id, value: stockQty }];
    const handling_time = parseJsonAttr(tr.dataset.handlingTime, [
      { warehouse_id: 1, value: 0 },
    ]);

    const offer = {
      id,
      status,
      sale_price,
      vat_id,
      stock,
      handling_time,
    };
    if (isNameDirty(tr)) {
      const name = getRowName(tr);
      if (name) offer.name = name;
    }
    if (isDescriptionDirty(tr)) {
      offer.description = getRowDescription(tr);
    }
    if (Number.isFinite(prp)) offer.recommended_price = prp;
    if (Number.isFinite(min)) offer.min_sale_price = min;
    if (Number.isFinite(max)) offer.max_sale_price = max;
    offers.push(offer);
  });
  return { offers, errors };
}

function markJustSynced(tr) {
  tr.classList.add("is-just-synced");
  const pretCell = tr.querySelector("td.col-pret-emag");
  const prpCell = tr.querySelector("td[data-col='prp']");
  const minCell = tr.querySelector("td[data-col='pret_minim']");
  const maxCell = tr.querySelector("td[data-col='pret_maxim']");
  const stocCell = tr.querySelector("td[data-col='stoc']");
  const nameCell = tr.querySelector("td[data-col='name']");
  const descriptionCell = tr.querySelector("td[data-col='description']");
  if (pretCell) pretCell.classList.add("is-just-synced");
  if (prpCell) prpCell.classList.add("is-just-synced");
  if (minCell) minCell.classList.add("is-just-synced");
  if (maxCell) maxCell.classList.add("is-just-synced");
  if (stocCell) stocCell.classList.add("is-just-synced");
  if (nameCell) nameCell.classList.add("is-just-synced");
  if (descriptionCell) descriptionCell.classList.add("is-just-synced");
}

function clearDirtyAfterSync(offers) {
  const byId = new Map(offers.map((o) => [String(o.id), o]));
  tbody.querySelectorAll("tr.is-price-dirty").forEach((tr) => {
    const offer = byId.get(String(tr.dataset.offerId));
    if (!offer) return;
    tr.dataset.originalSale = String(offer.sale_price);
    if (offer.recommended_price != null) {
      tr.dataset.originalPrp = String(offer.recommended_price);
    }
    if (offer.min_sale_price != null) {
      tr.dataset.originalMin = String(offer.min_sale_price);
    }
    if (offer.max_sale_price != null) {
      tr.dataset.originalMax = String(offer.max_sale_price);
    }
    if (Array.isArray(offer.stock)) {
      const sum = stockSumFromArr(offer.stock);
      tr.dataset.originalStock = String(sum);
      tr.dataset.stock = JSON.stringify(offer.stock);
      const stockInput = tr.querySelector("input.input-stock");
      if (stockInput) stockInput.value = String(sum);
    }
    if (offer.name != null) {
      const syncedName = String(offer.name);
      tr.dataset.originalName = syncedName;
      const nameInput = tr.querySelector("textarea.input-name");
      if (nameInput) {
        nameInput.value = syncedName;
        autosizeNameTextarea(nameInput);
      }
    }
    if (offer.description != null) {
      const syncedDescription = String(offer.description);
      tr.dataset.originalDescription = syncedDescription;
      const descriptionInput = tr.querySelector("textarea.input-description");
      if (descriptionInput) {
        descriptionInput.value = syncedDescription;
        autosizeDescriptionTextarea(descriptionInput);
      }
    }
    applyRowPrices(tr, offer.sale_price, { markDirty: true });
    markJustSynced(tr);
  });
  updateToolbarTotals();
}

async function syncPrices() {
  if (syncing) return;
  const { offers, errors } = collectDirtyOffers();
  if (errors.length > 0) {
    console.error("[eMAG sync] validare eșuată:", errors);
    setStatus(errors.join(" | "), "error");
    return;
  }
  if (offers.length === 0) {
    setStatus("Nicio schimbare de preț/stoc/nume/descriere de sincronizat.", "error");
    return;
  }

  syncing = true;
  btnSync.disabled = true;
  setStatus(
    `Se sincronizează ${offers.length} oferte (preț/stoc/nume/descriere)…`,
    "loading"
  );
  console.log(
    `[eMAG sync] trimit ${offers.length} oferte:`,
    offers.map((o) => ({
      id: o.id,
      name: o.name,
      description:
        o.description != null
          ? `${String(o.description).slice(0, 80)}…`
          : undefined,
      sale_price: o.sale_price,
      stock: o.stock,
      recommended_price: o.recommended_price,
      min_sale_price: o.min_sale_price,
      max_sale_price: o.max_sale_price,
    }))
  );

  try {
    const res = await fetch("/api/products/sync-prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offers }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("[eMAG sync] eșuat:", res.status, data);
      const detail = formatEmagMessages(data.messages);
      throw new Error(
        (data.error || `Eroare HTTP ${res.status}`) + (detail ? ` — ${detail}` : "")
      );
    }
    console.log("[eMAG sync] OK — updatate pe eMAG:", data);
    clearDirtyAfterSync(offers);
    if (syncInfoBanner) syncInfoBanner.hidden = false;
    const msgDetail = formatEmagMessages(data.messages);
    setStatus(
      `Sincronizate ${offers.length} oferte (preț/stoc/nume/descriere) cu eMAG.` +
        (msgDetail ? ` ${msgDetail}` : ""),
      msgDetail ? "loading" : "ok"
    );
  } catch (err) {
    console.error("[eMAG sync] eroare:", err.message);
    setStatus(err.message || "Eroare la sync", "error");
  } finally {
    syncing = false;
    updateSyncButton();
  }
}

tbody.addEventListener("input", (e) => {
  const alteInput = e.target.closest("input.input-alte-costuri");
  if (alteInput) {
    const tr = alteInput.closest("tr[data-offer-id]");
    if (!tr) return;
    tr.dataset.alteOverride =
      alteInput.value === "" ? "0" : alteInput.value;
    syncAlteCosturiCell(tr, getRowAlteCosturi(tr));
    const saleInput = tr.querySelector("input.input-sale-price");
    applyRowPrices(tr, saleInput?.value ?? "");
    updateToolbarTotals();
    schedulePersistAlteCosturi(
      tr.dataset.offerId,
      alteInput.value === "" ? 0 : alteInput.value
    );
    return;
  }

  const pctInput = e.target.closest("input.input-procentaj-profit");
  if (pctInput) {
    const tr = pctInput.closest("tr[data-offer-id]");
    if (!tr) return;
    const pretCumparare = tr.dataset.pretCumparare ?? "";
    const alteCosturi = getRowAlteCosturi(tr);
    const sale = saleFromProcentaj(pctInput.value, pretCumparare, alteCosturi);
    if (sale == null) return;
    const saleInput = tr.querySelector("input.input-sale-price");
    if (saleInput) saleInput.value = String(sale);
    applyRowPrices(tr, sale);
    updateToolbarTotals();
    return;
  }

  const stockInput = e.target.closest("input.input-stock");
  if (stockInput) {
    const tr = stockInput.closest("tr[data-offer-id]");
    if (!tr) return;
    setRowStock(tr, stockInput.value === "" ? 0 : stockInput.value);
    const saleInput = tr.querySelector("input.input-sale-price");
    applyRowPrices(tr, saleInput?.value ?? "");
    updateToolbarTotals();
    return;
  }

  const nameInput = e.target.closest("textarea.input-name");
  if (nameInput) {
    const tr = nameInput.closest("tr[data-offer-id]");
    if (!tr) return;
    autosizeNameTextarea(nameInput);
    const saleInput = tr.querySelector("input.input-sale-price");
    applyRowPrices(tr, saleInput?.value ?? "");
    updateToolbarTotals();
    return;
  }

  const descriptionInput = e.target.closest("textarea.input-description");
  if (descriptionInput) {
    const tr = descriptionInput.closest("tr[data-offer-id]");
    if (!tr) return;
    autosizeDescriptionTextarea(descriptionInput);
    const saleInput = tr.querySelector("input.input-sale-price");
    applyRowPrices(tr, saleInput?.value ?? "");
    updateToolbarTotals();
    return;
  }

  const input = e.target.closest("input.input-sale-price");
  if (!input) return;
  const tr = input.closest("tr[data-offer-id]");
  if (!tr) return;
  applyRowPrices(tr, input.value);
  updateToolbarTotals();
});

tbody.addEventListener("click", (e) => {
  const resetBtn = e.target.closest("button.btn-reset-alte");
  if (!resetBtn) return;
  const tr = resetBtn.closest("tr[data-offer-id]");
  if (!tr) return;
  delete tr.dataset.alteOverride;
  const linked = getRowAlteCosturi(tr);
  const alteInput = tr.querySelector("input.input-alte-costuri");
  if (alteInput) {
    alteInput.value =
      linked == null || !Number.isFinite(Number(linked)) ? "" : String(linked);
  }
  syncAlteCosturiCell(tr, linked);
  const saleInput = tr.querySelector("input.input-sale-price");
  applyRowPrices(tr, saleInput?.value ?? "");
  updateToolbarTotals();
  schedulePersistAlteCosturi(tr.dataset.offerId, null);
});

const altePersistTimers = new Map();

function schedulePersistAlteCosturi(offerId, value) {
  const id = String(offerId ?? "");
  if (!id) return;
  const prev = altePersistTimers.get(id);
  if (prev) clearTimeout(prev);
  altePersistTimers.set(
    id,
    setTimeout(() => {
      altePersistTimers.delete(id);
      persistAlteCosturi(id, value);
    }, 300)
  );
}

async function persistAlteCosturi(offerId, value) {
  const id = Number(offerId);
  if (!Number.isFinite(id)) return;
  const body =
    value === null || value === undefined || value === ""
      ? { id, alte_costuri: null }
      : { id, alte_costuri: Number(value) };
  if (body.alte_costuri !== null && !Number.isFinite(body.alte_costuri)) return;
  try {
    const res = await fetch("/api/products/alte-costuri", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    console.error("[alte-costuri] salvare eșuată:", err.message);
  }
}

btnSaveSettings.addEventListener("click", saveSettings);
btnLoad.addEventListener("click", () => loadProducts({ append: false }));
btnMore.addEventListener("click", () => loadProducts({ append: true }));
btnSync.addEventListener("click", syncPrices);

table.querySelector("thead")?.addEventListener("click", (e) => {
  if (e.target.closest(".filter-row") || e.target.closest(".col-filter")) return;
  const th = e.target.closest("thead tr:not(.filter-row) th[data-col]");
  if (!th) return;
  const col = th.dataset.col;
  if (sortCol === col) {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  } else {
    sortCol = col;
    sortDir = "asc";
  }
  sortProductsTable();
});

table.querySelector("thead tr.filter-row")?.addEventListener("input", (e) => {
  if (!e.target.closest(".col-filter")) return;
  scheduleColumnFilters();
});

table.querySelector("thead tr.filter-row")?.addEventListener("click", (e) => {
  e.stopPropagation();
});

function onSettingsInput() {
  updateDerivedCells();
  updateSaveDirtyState();
}

inputProcentaj.addEventListener("input", onSettingsInput);
inputProcentajAlte.addEventListener("input", onSettingsInput);
inputMultPrp.addEventListener("input", onSettingsInput);
inputMultMin.addEventListener("input", onSettingsInput);
inputMultMax.addEventListener("input", onSettingsInput);

btnColumns.addEventListener("click", (e) => {
  e.stopPropagation();
  setColumnMenuOpen(colMenu.hidden);
});

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

colMenu.addEventListener("change", (e) => {
  const input = e.target.closest("input[data-col-toggle]");
  if (!input) return;
  const col = input.dataset.colToggle;
  if (input.checked) {
    hiddenCols = hiddenCols.filter((c) => c !== col);
  } else {
    if (!hiddenCols.includes(col)) hiddenCols.push(col);
  }
  saveHiddenCols();
  applyColumnVisibility();
});

colMenu.addEventListener("dragstart", (e) => {
  const handle = e.target.closest(".col-drag-handle");
  const item = handle?.closest(".col-menu-item");
  if (!item) {
    e.preventDefault();
    return;
  }
  dragCol = item.dataset.col;
  item.classList.add("is-dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragCol);
});

colMenu.addEventListener("dragend", () => {
  dragCol = null;
  colMenu.querySelectorAll(".col-menu-item").forEach((el) => {
    el.classList.remove("is-dragging", "is-drop-before", "is-drop-after");
  });
});

colMenu.addEventListener("dragover", (e) => {
  e.preventDefault();
  const item = e.target.closest(".col-menu-item");
  if (!item || !dragCol || item.dataset.col === dragCol) return;
  e.dataTransfer.dropEffect = "move";
  const rect = item.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  colMenu.querySelectorAll(".col-menu-item").forEach((el) => {
    el.classList.remove("is-drop-before", "is-drop-after");
  });
  item.classList.add(before ? "is-drop-before" : "is-drop-after");
});

colMenu.addEventListener("drop", (e) => {
  e.preventDefault();
  const item = e.target.closest(".col-menu-item");
  if (!item || !dragCol || item.dataset.col === dragCol) return;
  const from = columnOrder.indexOf(dragCol);
  const toCol = item.dataset.col;
  let to = columnOrder.indexOf(toCol);
  if (from < 0 || to < 0) return;
  const rect = item.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  if (!before) to += 1;
  if (from < to) to -= 1;
  if (from === to) return;
  columnOrder.splice(from, 1);
  columnOrder.splice(to, 0, dragCol);
  saveColumnOrder();
  applyColumnOrder();
  buildColumnMenu();
});

colMenu.addEventListener("click", (e) => e.stopPropagation());

document.addEventListener("click", () => {
  if (!colMenu.hidden) setColumnMenuOpen(false);
});

applyColumnOrder();
buildColumnMenu();
applyColumnVisibility();
updateSyncButton();
loadSettings().then(() => {
  if (!restoreProductsCache()) {
    setStatus("Apasă Reload produse — sau rămâi pe cache după încărcare.", "");
  }
});
