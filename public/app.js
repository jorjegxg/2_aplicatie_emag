const btnLoad = document.getElementById("btn-load");
const btnMore = document.getElementById("btn-more");
const btnSaveSettings = document.getElementById("btn-save-settings");
const btnFetchCommission = document.getElementById("btn-fetch-commission");
const btnSync = document.getElementById("btn-sync");
const btnPull = document.getElementById("btn-pull");
const channelSelect = document.getElementById("channel-select");
const btnColumns = document.getElementById("btn-columns");
const btnExport = document.getElementById("btn-export");
const btnExportMenu = document.getElementById("btn-export-menu");
const exportMenu = document.getElementById("export-menu");
const btnTableFullscreen = document.getElementById("btn-table-fullscreen");
const colMenu = document.getElementById("col-menu");
const statusEl = document.getElementById("status");
const syncInfoBanner = document.getElementById("sync-info-banner");
const tbody = document.getElementById("products-body");
const table = document.getElementById("products-table");
const pageEl = document.querySelector(".page");
const inputProcentajAlte = document.getElementById("procentaj-alte-costuri");
const inputProcentajContabil = document.getElementById("procentaj-pret-contabil");
const inputMultPrp = document.getElementById("mult-prp");
const inputMultMin = document.getElementById("mult-min");
const inputMultMax = document.getElementById("mult-max");
const inputTotalAlteStoc = document.getElementById("total-alte-stoc");
const inputTotalContabilStoc = document.getElementById("total-contabil-stoc");
const inputTotalProfitStoc = document.getElementById("total-profit-stoc");

const HIDDEN_COLS_KEY = "emag-hidden-columns";
const COL_ORDER_KEY = "emag-column-order";
const TABLE_FULLSCREEN_KEY = "emag-table-fullscreen";
const CHANNEL_KEY = "marketplace-channel";
const DEFAULT_ALTE_COSTURI = 0;
const DEFAULT_PRET_CONTABIL = 0;
const DEFAULT_PROcentaj_EMAG = 25;

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
let fetchingCommission = false;
let exporting = false;
let hiddenCols = loadHiddenCols();
let currentChannel = localStorage.getItem(CHANNEL_KEY) || "emag";
let lastSyncAt = null;
let pulling = false;
let columnOrder = loadColumnOrder();
let dragCol = null;
let savedSettingsSnapshot = null;
let sortCol = null;
let sortDir = "asc";

function migrateLegacyCostCols(cols) {
  const OLD = new Set(["pret_transport", "procentaj_alte_costuri"]);
  const out = [];
  let insertedAlte = false;
  for (const c of cols) {
    if (c === "pret_transport") {
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
  inputProcentajAlte.value =
    settings.procentaj_alte_costuri != null
      ? settings.procentaj_alte_costuri
      : "";
  inputProcentajContabil.value =
    settings.procentaj_pret_contabil != null
      ? settings.procentaj_pret_contabil
      : "";
  inputMultPrp.value = settings.mult_prp != null ? settings.mult_prp : "";
  inputMultMin.value = settings.mult_min != null ? settings.mult_min : "";
  inputMultMax.value = settings.mult_max != null ? settings.mult_max : "";
  snapshotSettings();
}

function readSettingsFromForm() {
  return {
    procentaj_alte_costuri: inputProcentajAlte.value,
    procentaj_pret_contabil: inputProcentajContabil.value,
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

function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}

function relativeTimeRo(iso) {
  const d = daysSince(iso);
  if (d == null) return "—";
  const days = Math.floor(d);
  if (days <= 0) {
    const hours = Math.floor(d * 24);
    if (hours <= 0) return "acum";
    return `acum ${hours} h`;
  }
  if (days === 1) return "acum 1 zi";
  if (days < 30) return `acum ${days} zile`;
  const months = Math.floor(days / 30);
  if (months === 1) return "acum ~1 lună";
  if (months < 12) return `acum ~${months} luni`;
  const years = Math.floor(days / 365);
  return years === 1 ? "acum ~1 an" : `acum ~${years} ani`;
}

function stalenessClass(iso) {
  const d = daysSince(iso);
  if (d == null) return "";
  if (d < 30) return "is-stale-fresh";
  if (d < 90) return "is-stale-warn";
  return "is-stale-old";
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

function parsePretContabil(raw) {
  if (raw == null || raw === "") return DEFAULT_PRET_CONTABIL;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_PRET_CONTABIL;
}

function getGlobalProcentajAlte() {
  const raw = inputProcentajAlte?.value;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function getGlobalProcentajContabil() {
  const raw = inputProcentajContabil?.value;
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

function getRowPretContabil(tr) {
  if (hasContabilOverride(tr)) {
    return parsePretContabil(tr.dataset.contabilOverride);
  }
  const pct = getGlobalProcentajContabil();
  if (pct == null) return DEFAULT_PRET_CONTABIL;
  return contabilFromProcentaj(pct, tr?.dataset?.pretCumparare ?? "");
}

function hasAlteOverride(tr) {
  return tr?.dataset?.alteOverride != null && tr.dataset.alteOverride !== "";
}

function hasContabilOverride(tr) {
  return (
    tr?.dataset?.contabilOverride != null && tr.dataset.contabilOverride !== ""
  );
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

function syncPretContabilCell(tr, pretContabil) {
  const cell = tr.querySelector("td[data-col='pret_contabil']");
  if (!cell) return;
  const input = cell.querySelector("input.input-pret-contabil");
  const resetBtn = cell.querySelector("button.btn-reset-contabil");
  const overridden = hasContabilOverride(tr);
  if (input && !overridden) {
    input.value =
      pretContabil == null || !Number.isFinite(Number(pretContabil))
        ? ""
        : String(pretContabil);
  }
  if (resetBtn) resetBtn.hidden = !overridden;
  cell.classList.toggle("is-contabil-override", overridden);
}

function isEmagCommissionFetched(commissionValue) {
  return commissionValue != null && Number(commissionValue) > 0;
}

function getRowProcentajEmag(tr) {
  const commRaw = tr?.dataset?.emagCommissionValue;
  if (isEmagCommissionFetched(commRaw)) {
    const raw = tr?.dataset?.emagPct;
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  const input = tr?.querySelector("input.input-procentaj-emag");
  if (input) {
    const n = Number(input.value);
    return Number.isFinite(n) ? n : DEFAULT_PROcentaj_EMAG;
  }
  return DEFAULT_PROcentaj_EMAG;
}

function formatProcentajEmagDisplay(pct, commissionValue, fetchedAt) {
  if (pct == null || !Number.isFinite(Number(pct))) return "—";
  const n = Number(pct);
  const formatted = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `${formatted} %`;
}

function procentajEmagTooltip(commissionValue, fetchedAt) {
  const parts = [];
  if (commissionValue != null && Number.isFinite(Number(commissionValue))) {
    parts.push(`Comision: ${Number(commissionValue).toFixed(2)} RON`);
  }
  if (fetchedAt) {
    try {
      parts.push(`preluat ${new Date(fetchedAt).toLocaleString("ro-RO")}`);
    } catch {
      parts.push(`preluat ${fetchedAt}`);
    }
  }
  return parts.length ? parts.join(" · ") : "";
}

function procentajEmagInputHtml(value, showReset = false) {
  const val =
    value == null || !Number.isFinite(Number(value))
      ? DEFAULT_PROcentaj_EMAG
      : Number(value);
  return `<div class="procentaj-emag-wrap"><input type="number" class="input-procentaj-emag" min="0" max="100" step="0.01" value="${escapeHtml(val)}" /><span class="procentaj-emag-suffix" aria-hidden="true">%</span><button type="button" class="btn-reset-emag-pct"${showReset ? "" : " hidden"} aria-label="Revine la 25%">×</button></div>`;
}

function syncProcentajEmagEditableCell(tr) {
  const cell = tr.querySelector("td[data-col='procentaj_emag']");
  if (!cell || cell.classList.contains("has-emag-commission")) return;
  const input = cell.querySelector("input.input-procentaj-emag");
  if (!input) return;
  const n = Number(input.value);
  const overridden = Number.isFinite(n) && n !== DEFAULT_PROcentaj_EMAG;
  const resetBtn = cell.querySelector("button.btn-reset-emag-pct");
  if (resetBtn) resetBtn.hidden = !overridden;
  cell.classList.toggle("is-emag-pct-override", overridden);
  cell.classList.add("col-procentaj-emag");
}

function syncProcentajEmagCell(tr, pct, commissionValue, fetchedAt) {
  const cell = tr.querySelector("td[data-col='procentaj_emag']");
  if (!cell) return;
  const isFetched = isEmagCommissionFetched(commissionValue);
  if (isFetched) {
    cell.textContent = formatProcentajEmagDisplay(pct, commissionValue, fetchedAt);
    const tip = procentajEmagTooltip(commissionValue, fetchedAt);
    if (tip) cell.title = tip;
    else cell.removeAttribute("title");
    cell.classList.add("col-procentaj-emag", "has-emag-commission");
    cell.classList.remove("is-emag-pct-override");
  } else {
    cell.removeAttribute("title");
    cell.classList.add("col-procentaj-emag");
    cell.classList.remove("has-emag-commission");
    let input = cell.querySelector("input.input-procentaj-emag");
    if (!input) {
      cell.innerHTML = procentajEmagInputHtml(pct);
      input = cell.querySelector("input.input-procentaj-emag");
    } else if (pct != null && Number.isFinite(Number(pct))) {
      input.value = String(Number(pct));
    }
    syncProcentajEmagEditableCell(tr);
  }
}

function hasMinOverride(tr) {
  return tr?.dataset?.minOverride != null && tr.dataset.minOverride !== "";
}

function getRowPretMinim(tr, salePrice) {
  if (hasMinOverride(tr)) {
    const n = Number(tr.dataset.minOverride);
    return Number.isFinite(n) ? n : null;
  }
  return derivePrices(salePrice).min;
}

function syncPretMinimCell(tr, value) {
  const minCell = tr.querySelector("td[data-col='pret_minim']");
  if (!minCell) return;
  const input = minCell.querySelector("input.input-pret-minim");
  const resetBtn = minCell.querySelector("button.btn-reset-min");
  const overridden = hasMinOverride(tr);
  const display =
    value == null || !Number.isFinite(Number(value)) ? "" : String(value);
  if (input && !overridden) {
    input.value = display;
  }
  minCell.dataset.value = display;
  if (resetBtn) resetBtn.hidden = !overridden;
  minCell.classList.toggle("is-min-override", overridden);
  minCell.classList.toggle("col-pret-minim", true);
}

function alteFromProcentaj(procentaj, pretCumparare) {
  const buy = Number(pretCumparare);
  const pct = Number(procentaj);
  if (!Number.isFinite(buy) || buy <= 0 || !Number.isFinite(pct)) {
    return DEFAULT_ALTE_COSTURI;
  }
  return Math.round(buy * (pct / 100) * 100) / 100;
}

function contabilFromProcentaj(procentaj, pretCumparare) {
  const buy = Number(pretCumparare);
  const pct = Number(procentaj);
  if (!Number.isFinite(buy) || buy <= 0 || !Number.isFinite(pct)) {
    return DEFAULT_PRET_CONTABIL;
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

function updateTotalContabilStoc() {
  if (!inputTotalContabilStoc) return;
  const rows = tbody.querySelectorAll("tr[data-offer-id]");
  if (!rows.length) {
    inputTotalContabilStoc.value = "—";
    return;
  }
  let total = 0;
  rows.forEach((tr) => {
    total += getRowPretContabil(tr) * getRowStock(tr);
  });
  inputTotalContabilStoc.value = total.toFixed(2);
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
      getRowAlteCosturi(tr),
      getRowPretContabil(tr),
      getRowProcentajEmag(tr)
    );
    if (profit == null || !Number.isFinite(profit)) return;
    total += profit * getRowStock(tr);
    any = true;
  });
  inputTotalProfitStoc.value = any ? total.toFixed(2) : "—";
}

function updateToolbarTotals() {
  updateTotalAlteStoc();
  updateTotalContabilStoc();
  updateTotalProfitStoc();
}

function calcProfit(
  salePrice,
  pretCumparare,
  alteCosturi = DEFAULT_ALTE_COSTURI,
  pretContabil = DEFAULT_PRET_CONTABIL,
  pctEmag
) {
  if (pctEmag == null || pctEmag === "") return null;
  const pct = Number(pctEmag);
  if (salePrice == null || salePrice === "" || Number.isNaN(pct)) {
    return null;
  }
  const sale = Number(salePrice);
  if (Number.isNaN(sale)) return null;

  const afterEmag = sale * (1 - pct / 100);
  const buy = Number(pretCumparare);
  const buyCost =
    pretCumparare == null || pretCumparare === "" || Number.isNaN(buy) ? 0 : buy;
  const other = parseAlteCosturi(alteCosturi);
  const contabil = parsePretContabil(pretContabil);

  return afterEmag - buyCost - other - contabil;
}

function calcProcentajProfit(
  salePrice,
  pretCumparare,
  alteCosturi = DEFAULT_ALTE_COSTURI,
  pretContabil = DEFAULT_PRET_CONTABIL,
  pctEmag
) {
  const profit = calcProfit(
    salePrice,
    pretCumparare,
    alteCosturi,
    pretContabil,
    pctEmag
  );
  const minProfit = calcPretMinimProfit(
    pretCumparare,
    alteCosturi,
    pretContabil,
    pctEmag
  );
  if (profit == null || minProfit == null) return null;
  if (!Number.isFinite(profit) || !Number.isFinite(minProfit) || minProfit === 0) {
    return null;
  }
  return (profit / minProfit) * 100;
}

function saleFromProcentaj(
  procentaj,
  pretCumparare,
  alteCosturi = DEFAULT_ALTE_COSTURI,
  pretContabil = DEFAULT_PRET_CONTABIL,
  pctEmag
) {
  if (procentaj == null || procentaj === "" || pctEmag == null || pctEmag === "") {
    return null;
  }
  const pctEmagVal = Number(pctEmag);
  const pctTarget = Number(procentaj);
  if (Number.isNaN(pctTarget) || Number.isNaN(pctEmagVal) || pctEmagVal >= 100) {
    return null;
  }

  const factor = 1 - pctEmagVal / 100;
  if (factor <= 0) return null;

  const minProfit = calcPretMinimProfit(
    pretCumparare,
    alteCosturi,
    pretContabil,
    pctEmagVal
  );
  if (minProfit == null || !Number.isFinite(minProfit)) return null;

  const buy = Number(pretCumparare);
  const buyCost =
    pretCumparare == null || pretCumparare === "" || Number.isNaN(buy) ? 0 : buy;
  const costs =
    buyCost + parseAlteCosturi(alteCosturi) + parsePretContabil(pretContabil);

  return roundPrice((costs + (pctTarget / 100) * minProfit) / factor);
}

function calcPretMinimProfit(
  pretCumparare,
  alteCosturi = DEFAULT_ALTE_COSTURI,
  pretContabil = DEFAULT_PRET_CONTABIL,
  pctEmag
) {
  if (pctEmag == null || pctEmag === "") return null;
  const pct = Number(pctEmag);
  if (Number.isNaN(pct) || pct >= 100) return null;

  const buy = Number(pretCumparare);
  const buyCost =
    pretCumparare == null || pretCumparare === "" || Number.isNaN(buy) ? 0 : buy;
  const costs =
    buyCost + parseAlteCosturi(alteCosturi) + parsePretContabil(pretContabil);
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

function syncMinProfitVsEmag(
  tr,
  salePrice,
  pretCumparare,
  alteCosturi,
  pretContabil,
  pctEmag
) {
  const minProfitCell = tr.querySelector("td[data-col='pret_minim_profit']");
  if (!minProfitCell) return;
  const minProfit = calcPretMinimProfit(
    pretCumparare,
    alteCosturi,
    pretContabil,
    pctEmag
  );
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
  const pretContabil = getRowPretContabil(tr);
  const pctEmag = getRowProcentajEmag(tr);
  const derived = derivePrices(salePrice);

  const profitCell = tr.querySelector("td.col-profit");
  if (profitCell) {
    profitCell.dataset.salePrice = salePrice ?? "";
    profitCell.innerHTML = formatPrice(
      calcProfit(salePrice, pretCumparare, alteCosturi, pretContabil, pctEmag),
      currency
    );
  }

  const procentajCell = tr.querySelector("td.col-procentaj-profit");
  if (procentajCell) {
    fillProcentajCell(
      procentajCell,
      calcProcentajProfit(
        salePrice,
        pretCumparare,
        alteCosturi,
        pretContabil,
        pctEmag
      )
    );
  }

  const prpCell = tr.querySelector("td[data-col='prp']");
  if (prpCell && derived.prp != null) {
    prpCell.dataset.value = String(derived.prp);
    prpCell.innerHTML = formatPrice(derived.prp, currency);
  }

  const minCell = tr.querySelector("td[data-col='pret_minim']");
  const rowMin = getRowPretMinim(tr, salePrice);
  if (minCell) {
    syncPretMinimCell(tr, rowMin);
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
  syncPretContabilCell(tr, pretContabil);
  syncProcentajEmagCell(
    tr,
    pctEmag,
    tr.dataset.emagCommissionValue ?? null,
    tr.dataset.emagCommissionFetchedAt ?? null
  );
  const original = tr.dataset.originalSale ?? "";
  const priceDirty =
    markDirty &&
    (!pricesEqual(salePrice, original) ||
      (derived.prp != null && !pricesEqual(derived.prp, tr.dataset.originalPrp)) ||
      (rowMin != null && !pricesEqual(rowMin, tr.dataset.originalMin)) ||
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
      calcPretMinimProfit(pretCumparare, alteCosturi, pretContabil, pctEmag),
      currency
    );
  }

  syncMinProfitVsEmag(
    tr,
    salePrice,
    pretCumparare,
    alteCosturi,
    pretContabil,
    pctEmag
  );
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
  const hasContabilOverrideFlag =
    product.pret_contabil != null && Number.isFinite(Number(product.pret_contabil));
  const contabil = hasContabilOverrideFlag
    ? Number(product.pret_contabil)
    : contabilFromProcentaj(getGlobalProcentajContabil() ?? "", pretCumparare);
  const contabilInputVal =
    contabil == null || !Number.isFinite(Number(contabil))
      ? ""
      : Number(contabil);
  const hasEmagPct =
    product.procentaj_emag != null && Number.isFinite(Number(product.procentaj_emag));
  const pctEmagRaw = hasEmagPct ? Number(product.procentaj_emag) : null;
  const commissionValue =
    product.commission_value != null && Number.isFinite(Number(product.commission_value))
      ? Number(product.commission_value)
      : null;
  const isEmagFetched = hasEmagPct && isEmagCommissionFetched(commissionValue);
  const pctEmag = isEmagFetched
    ? pctEmagRaw
    : hasEmagPct
      ? pctEmagRaw
      : DEFAULT_PROcentaj_EMAG;
  const emagInputVal = isEmagFetched ? null : pctEmag;
  const commissionFetchedAt = product.commission_fetched_at ?? "";
  const emagPctDisplay = formatProcentajEmagDisplay(
    pctEmagRaw,
    commissionValue,
    commissionFetchedAt
  );
  const emagPctTooltip = escapeHtml(procentajEmagTooltip(commissionValue, commissionFetchedAt));
  const hasEmagPctOverride =
    !isEmagFetched &&
    emagInputVal != null &&
    Number.isFinite(Number(emagInputVal)) &&
    Number(emagInputVal) !== DEFAULT_PROcentaj_EMAG;
  const hasMinOverrideFlag =
    product.pret_minim_override != null &&
    Number.isFinite(Number(product.pret_minim_override));
  const minDisplay = hasMinOverrideFlag
    ? Number(product.pret_minim_override)
    : product.min_sale_price;
  const minInputVal =
    minDisplay == null || !Number.isFinite(Number(minDisplay))
      ? ""
      : Number(minDisplay);
  const minProfit = calcPretMinimProfit(pretCumparare, alte, contabil, pctEmag);
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
    alte,
    contabil,
    pctEmag
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
    pret_cumparare: `<td data-col="pret_cumparare"${cellClass("pret_cumparare", "col-pret-cumparare")}><input type="number" class="input-pret-cumparare" min="0" step="0.01" value="${escapeHtml(pretCumparare)}" /></td>`,
    alte_costuri: `<td data-col="alte_costuri"${cellClass("alte_costuri", hasOverride ? "col-alte-costuri is-alte-override" : "col-alte-costuri")}><div class="alte-costuri-wrap"><input type="number" class="input-alte-costuri" min="0" step="0.01" value="${escapeHtml(alteInputVal)}" /><button type="button" class="btn-reset-alte"${hasOverride ? "" : " hidden"} aria-label="Revine la procentaj">×</button></div></td>`,
    pret_contabil: `<td data-col="pret_contabil"${cellClass("pret_contabil", hasContabilOverrideFlag ? "col-pret-contabil is-contabil-override" : "col-pret-contabil")}><div class="pret-contabil-wrap"><input type="number" class="input-pret-contabil" min="0" step="0.01" value="${escapeHtml(contabilInputVal)}" /><button type="button" class="btn-reset-contabil"${hasContabilOverrideFlag ? "" : " hidden"} aria-label="Revine la procentaj">×</button></div></td>`,
    procentaj_emag: isEmagFetched
      ? `<td data-col="procentaj_emag"${cellClass("procentaj_emag", "col-procentaj-emag has-emag-commission")}${emagPctTooltip ? ` title="${emagPctTooltip}"` : ""}>${escapeHtml(emagPctDisplay)}</td>`
      : `<td data-col="procentaj_emag"${cellClass("procentaj_emag", hasEmagPctOverride ? "col-procentaj-emag is-emag-pct-override" : "col-procentaj-emag")}>${procentajEmagInputHtml(emagInputVal, hasEmagPctOverride)}</td>`,
    pret_minim_profit: `<td data-col="pret_minim_profit"${cellClass("pret_minim_profit", minProfitExtra)}>${formatPrice(minProfit, currency)}</td>`,
    pret_emag: `<td data-col="pret_emag"${cellClass("pret_emag", "col-pret-emag")}><input type="number" class="input-sale-price" min="0" step="0.01" value="${escapeHtml(saleAttr)}" /></td>`,
    pret_emag_schimbat: `<td data-col="pret_emag_schimbat"${cellClass("pret_emag_schimbat", ["col-pret-schimbat", stalenessClass(product.pret_emag_last_change)].filter(Boolean).join(" "))}${product.pret_emag_last_change ? ` title="${escapeHtml(new Date(product.pret_emag_last_change).toLocaleString("ro-RO"))}"` : ""}>${escapeHtml(relativeTimeRo(product.pret_emag_last_change))}</td>`,
    istoric: `<td data-col="istoric"${cellClass("istoric", "col-istoric")}><button type="button" class="btn-history" data-offer-id="${escapeHtml(product.id)}" aria-label="Istoric preț și comenzi" title="Istoric preț și comenzi">📈</button></td>`,
    profit: `<td data-col="profit"${cellClass("profit", "col-profit")} data-sale-price="${escapeHtml(salePrice)}" data-pret-cumparare="${escapeHtml(pretCumparare)}" data-currency="${escapeHtml(currency)}">${formatPrice(calcProfit(product.sale_price, product.pret_cumparare, alte, contabil, pctEmag), currency)}</td>`,
    procentaj_profit: `<td data-col="procentaj_profit"${cellClass("procentaj_profit", procentajExtra)}><input type="number" class="input-procentaj-profit" step="0.01" value="${escapeHtml(procentajAttr)}" /></td>`,
    prp: `<td data-col="prp"${cellClass("prp", prpExtra)} data-value="${escapeHtml(product.recommended_price ?? "")}">${formatPrice(product.recommended_price, currency)}</td>`,
    pret_minim: `<td data-col="pret_minim"${cellClass("pret_minim", hasMinOverrideFlag ? "col-pret-minim is-min-override" : "col-pret-minim")} data-value="${escapeHtml(minInputVal)}"><div class="pret-minim-wrap"><input type="number" class="input-pret-minim" min="0" step="0.01" value="${escapeHtml(minInputVal)}" /><button type="button" class="btn-reset-min"${hasMinOverrideFlag ? "" : " hidden"} aria-label="Revine la multiplicator">×</button></div></td>`,
    pret_maxim: `<td data-col="pret_maxim"${cellClass("pret_maxim")} data-value="${escapeHtml(product.max_sale_price ?? "")}">${formatPrice(product.max_sale_price, currency)}</td>`,
    stoc: `<td data-col="stoc"${cellClass("stoc", "col-stoc")}><input type="number" class="input-stock" min="0" step="1" value="${escapeHtml(stockVal)}" /></td>`,
    status: `<td data-col="status"${cellClass("status")}>${formatStatus(product.status)}</td>`,
    ean_pnk: `<td data-col="ean_pnk"${cellClass("ean_pnk")}>${eanPnk(product)}</td>`,
  };
  return `<tr data-offer-id="${escapeHtml(product.id)}" data-original-sale="${escapeHtml(salePrice)}" data-original-stock="${escapeHtml(stockVal)}" data-original-name="${escapeHtml(product.name || "")}" data-original-description="" data-pret-cumparare="${escapeHtml(pretCumparare)}" data-currency="${escapeHtml(currency)}" data-original-prp="${escapeHtml(product.recommended_price ?? "")}" data-original-min="${escapeHtml(product.min_sale_price ?? "")}" data-original-max="${escapeHtml(product.max_sale_price ?? "")}" data-status="${escapeHtml(product.status ?? "")}" data-vat-id="${escapeHtml(product.vat_id ?? "")}" data-stock="${stockJson}" data-handling-time="${handlingJson}"${hasOverride ? ` data-alte-override="${escapeHtml(alteInputVal)}"` : ""}${hasContabilOverrideFlag ? ` data-contabil-override="${escapeHtml(contabilInputVal)}"` : ""}${isEmagFetched ? ` data-emag-pct="${escapeHtml(pctEmagRaw)}" data-emag-commission-value="${escapeHtml(commissionValue ?? "")}" data-emag-commission-fetched-at="${escapeHtml(commissionFetchedAt)}"` : ""}${hasMinOverrideFlag ? ` data-min-override="${escapeHtml(minInputVal)}"` : ""}>
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

  if (col === "pret_emag" || col === "procentaj_profit" || col === "alte_costuri" || col === "pret_contabil" || col === "pret_minim") {
    const input = td.querySelector("input");
    return parseSortNumber(input?.value);
  }
  if (col === "procentaj_emag") {
    const input = td.querySelector("input");
    if (input) return parseSortNumber(input.value);
    return getRowProcentajEmag(tr);
  }
  if (col === "prp" || col === "pret_maxim") {
    return parseSortNumber(td.dataset.value);
  }
  if (col === "profit") {
    const profit = calcProfit(
      td.dataset.salePrice,
      td.dataset.pretCumparare,
      getRowAlteCosturi(tr),
      getRowPretContabil(tr),
      getRowProcentajEmag(tr)
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
  if (col === "pret_cumparare") {
    return parseSortNumber(td.querySelector("input")?.value ?? "");
  }
  if (
    col === "index" ||
    col === "id" ||
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
    col === "pret_contabil" ||
    col === "pret_minim" ||
    col === "pret_cumparare" ||
    col === "stoc"
  ) {
    return String(td.querySelector("input")?.value ?? "").trim();
  }
  if (col === "procentaj_emag") {
    const input = td.querySelector("input");
    if (input) return String(input.value ?? "").trim();
    return String(td.textContent ?? "").trim();
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
      '<tr class="empty-row" data-filter-empty="1"><td colspan="25">Niciun rezultat pentru filtre.</td></tr>'
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

function applyCommissionToProduct(product, commission) {
  if (!commission) return product;
  return {
    ...product,
    procentaj_emag: commission.procentaj_emag,
    commission_value: commission.commission_value,
    commission_fetched_at: commission.fetched_at ?? null,
  };
}


function patchLoadedProductCommission(id, result) {
  const idx = loadedProducts.findIndex((p) => String(p.id) === String(id));
  if (idx === -1) return;
  loadedProducts[idx] = applyCommissionToProduct(loadedProducts[idx], {
    procentaj_emag: result.procentaj_emag,
    commission_value: result.commission_value,
    fetched_at: result.fetched_at,
  });
}



function applyCostOverrideToProduct(product, override) {
  if (!override) return product;
  const next = { ...product };
  if ("alte_costuri" in override) {
    next.alte_costuri =
      override.alte_costuri == null || !Number.isFinite(Number(override.alte_costuri))
        ? null
        : Number(override.alte_costuri);
  }
  if ("pret_contabil" in override) {
    next.pret_contabil =
      override.pret_contabil == null || !Number.isFinite(Number(override.pret_contabil))
        ? null
        : Number(override.pret_contabil);
  }
  return next;
}


function renderProducts(products, append) {
  if (!append) {
    tbody.innerHTML = "";
  }

  if (!append && products.length === 0) {
    tbody.innerHTML =
      '<tr class="empty-row"><td colspan="25">Niciun produs găsit.</td></tr>';
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

function formatSyncStamp(iso) {
  if (!iso) return "niciodată";
  try {
    return new Date(iso).toLocaleString("ro-RO");
  } catch {
    return String(iso);
  }
}

async function loadProducts() {
  if (loading) return;
  loading = true;
  btnLoad.disabled = true;
  setStatus("Se încarcă din baza de date…", "loading");

  try {
    const res = await fetch(`/api/catalog?channel=${encodeURIComponent(currentChannel)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Eroare HTTP ${res.status}`);

    loadedProducts = Array.isArray(data.products) ? data.products : [];
    lastSyncAt = data.last_sync || null;
    currentPage = 1;
    hasMore = false;
    btnMore.hidden = true;

    renderProducts(loadedProducts, false);
    if (!lastSyncAt) {
      setStatus(
        loadedProducts.length === 0
          ? `Nimic în DB pentru ${currentChannel} — apasă „Preia de la marketplace".`
          : `${loadedProducts.length} produse în DB, dar niciodată sincronizate cu ${currentChannel} — apasă „Preia de la marketplace" ca să completezi nume, preț și stoc.`,
        "error"
      );
    } else {
      setStatus(
        `${loadedProducts.length} produse din DB — ultima sincronizare ${currentChannel}: ${formatSyncStamp(lastSyncAt)}`,
        "ok"
      );
    }
  } catch (err) {
    setStatus(err.message || "Eroare la încărcare", "error");
    tbody.innerHTML = `<tr class="empty-row"><td colspan="25">${escapeHtml(
      err.message || "Eroare"
    )}</td></tr>`;
  } finally {
    loading = false;
    btnLoad.disabled = false;
    updateSyncButton();
  }
}

/** Trage ofertele de la marketplace in DB (snapshot + listings noi), apoi reincarca tabelul. */
async function pullFromChannel() {
  if (pulling) return;
  pulling = true;
  if (btnPull) btnPull.disabled = true;
  setStatus(`Se preiau ofertele de la ${currentChannel}…`, "loading");

  try {
    const res = await fetch(`/api/sync/pull?channel=${encodeURIComponent(currentChannel)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) {
      const detail = formatEmagMessages(data.messages);
      throw new Error((data.error || `Eroare HTTP ${res.status}`) + (detail ? ` — ${detail}` : ""));
    }
    lastSyncAt = data.last_sync || null;
    setStatus(
      `Preluate ${data.count} oferte (${data.created} noi, ${data.updated} actualizate).`,
      "ok"
    );
    await loadProducts();
  } catch (err) {
    console.error("[sync-pull]", err.message);
    setStatus(err.message || "Eroare la preluare", "error");
  } finally {
    pulling = false;
    if (btnPull) btnPull.disabled = false;
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
    const min = getRowPretMinim(tr, sale_price);
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
    // DB-ul e sursa de adevar: salvez intai valorile, apoi cer push-ul dupa id.
    for (const offer of offers) {
      const fields = {
        sale_price: offer.sale_price,
        stock: offer.stock,
        handling_time: offer.handling_time,
        status: offer.status,
        vat_id: offer.vat_id,
      };
      if (offer.recommended_price != null) fields.recommended_price = offer.recommended_price;
      if (offer.min_sale_price != null) fields.min_sale_price = offer.min_sale_price;
      if (offer.max_sale_price != null) fields.max_sale_price = offer.max_sale_price;
      if (offer.name != null) fields.name = offer.name;
      if (offer.description != null) fields.description = offer.description;
      await patchListing(offer.id, fields);
    }

    const res = await fetch(
      `/api/products/sync-prices?channel=${encodeURIComponent(currentChannel)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offers: offers.map((o) => ({ id: o.id })) }),
      }
    );
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

/** Pretul de cumparare se editeaza doar dupa confirmare explicita. */
tbody.addEventListener("change", (e) => {
  const input = e.target.closest("input.input-pret-cumparare");
  if (!input) return;
  const tr = input.closest("tr[data-offer-id]");
  if (!tr) return;

  const prev = tr.dataset.pretCumparare ?? "";
  const next = input.value;
  if (String(prev) === String(next)) return;

  const ok = window.confirm(
    "Ești sigur că vrei să schimbi prețul de cumpărare?"
  );
  if (!ok) {
    input.value = prev;
    return;
  }

  tr.dataset.pretCumparare = next;
  const profitCell = tr.querySelector("td.col-profit");
  if (profitCell) profitCell.dataset.pretCumparare = next;
  const saleInput = tr.querySelector("input.input-sale-price");
  applyRowPrices(tr, saleInput?.value ?? "");
  updateToolbarTotals();
  schedulePersistPretCumparare(tr.dataset.offerId, next);
});

tbody.addEventListener("input", (e) => {
  const emagPctInput = e.target.closest("input.input-procentaj-emag");
  if (emagPctInput) {
    const tr = emagPctInput.closest("tr[data-offer-id]");
    if (!tr) return;
    syncProcentajEmagEditableCell(tr);
    const saleInput = tr.querySelector("input.input-sale-price");
    applyRowPrices(tr, saleInput?.value ?? "");
    updateToolbarTotals();
    const val = emagPctInput.value;
    const n = Number(val);
    schedulePersistProcentajEmag(
      tr.dataset.offerId,
      val === "" || !Number.isFinite(n) || n === DEFAULT_PROcentaj_EMAG ? null : n
    );
    return;
  }

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

  const contabilInput = e.target.closest("input.input-pret-contabil");
  if (contabilInput) {
    const tr = contabilInput.closest("tr[data-offer-id]");
    if (!tr) return;
    tr.dataset.contabilOverride =
      contabilInput.value === "" ? "0" : contabilInput.value;
    syncPretContabilCell(tr, getRowPretContabil(tr));
    const saleInput = tr.querySelector("input.input-sale-price");
    applyRowPrices(tr, saleInput?.value ?? "");
    updateToolbarTotals();
    schedulePersistPretContabil(
      tr.dataset.offerId,
      contabilInput.value === "" ? 0 : contabilInput.value
    );
    return;
  }

  const minInput = e.target.closest("input.input-pret-minim");
  if (minInput) {
    const tr = minInput.closest("tr[data-offer-id]");
    if (!tr) return;
    tr.dataset.minOverride = minInput.value === "" ? "0" : minInput.value;
    const saleInput = tr.querySelector("input.input-sale-price");
    applyRowPrices(tr, saleInput?.value ?? "");
    updateToolbarTotals();
    schedulePersistPretMinim(
      tr.dataset.offerId,
      minInput.value === "" ? 0 : minInput.value
    );
    return;
  }

  const pctInput = e.target.closest("input.input-procentaj-profit");
  if (pctInput) {
    const tr = pctInput.closest("tr[data-offer-id]");
    if (!tr) return;
    const pretCumparare = tr.dataset.pretCumparare ?? "";
    const alteCosturi = getRowAlteCosturi(tr);
    const pretContabil = getRowPretContabil(tr);
    const pctEmag = getRowProcentajEmag(tr);
    const sale = saleFromProcentaj(
      pctInput.value,
      pretCumparare,
      alteCosturi,
      pretContabil,
      pctEmag
    );
    if (sale == null) return;
    const saleInput = tr.querySelector("input.input-sale-price");
    if (saleInput) saleInput.value = String(sale);
    applyRowPrices(tr, sale);
    updateToolbarTotals();
    schedulePersistSalePrice(tr.dataset.offerId, sale);
    schedulePersistDerived(tr);
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
    schedulePersistStock(tr.dataset.offerId, parseJsonAttr(tr.dataset.stock, []));
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
    schedulePersistName(tr.dataset.offerId, nameInput.value);
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
    schedulePersistDescription(tr.dataset.offerId, descriptionInput.value);
    return;
  }

  const input = e.target.closest("input.input-sale-price");
  if (!input) return;
  const tr = input.closest("tr[data-offer-id]");
  if (!tr) return;
  applyRowPrices(tr, input.value);
  updateToolbarTotals();
  schedulePersistSalePrice(tr.dataset.offerId, input.value);
  schedulePersistDerived(tr);
});

tbody.addEventListener("click", (e) => {
  const historyBtn = e.target.closest("button.btn-history");
  if (historyBtn) {
    const offerId = historyBtn.dataset.offerId;
    const tr = historyBtn.closest("tr[data-offer-id]");
    const name = tr ? getRowName(tr) : "";
    openHistoryModal(offerId, name);
    return;
  }

  const resetEmagPctBtn = e.target.closest("button.btn-reset-emag-pct");
  if (resetEmagPctBtn) {
    const tr = resetEmagPctBtn.closest("tr[data-offer-id]");
    if (!tr) return;
    const input = tr.querySelector("input.input-procentaj-emag");
    if (input) input.value = String(DEFAULT_PROcentaj_EMAG);
    syncProcentajEmagEditableCell(tr);
    const saleInput = tr.querySelector("input.input-sale-price");
    applyRowPrices(tr, saleInput?.value ?? "");
    updateToolbarTotals();
    schedulePersistProcentajEmag(tr.dataset.offerId, null);
    return;
  }

  const resetAlteBtn = e.target.closest("button.btn-reset-alte");
  if (resetAlteBtn) {
    const tr = resetAlteBtn.closest("tr[data-offer-id]");
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
    return;
  }

  const resetContabilBtn = e.target.closest("button.btn-reset-contabil");
  if (resetContabilBtn) {
    const tr = resetContabilBtn.closest("tr[data-offer-id]");
    if (!tr) return;
    delete tr.dataset.contabilOverride;
    const linked = getRowPretContabil(tr);
    const contabilInput = tr.querySelector("input.input-pret-contabil");
    if (contabilInput) {
      contabilInput.value =
        linked == null || !Number.isFinite(Number(linked)) ? "" : String(linked);
    }
    syncPretContabilCell(tr, linked);
    const saleInput = tr.querySelector("input.input-sale-price");
    applyRowPrices(tr, saleInput?.value ?? "");
    updateToolbarTotals();
    schedulePersistPretContabil(tr.dataset.offerId, null);
    return;
  }

  const resetMinBtn = e.target.closest("button.btn-reset-min");
  if (!resetMinBtn) return;
  const tr = resetMinBtn.closest("tr[data-offer-id]");
  if (!tr) return;
  delete tr.dataset.minOverride;
  const saleInput = tr.querySelector("input.input-sale-price");
  const sale = saleInput?.value ?? "";
  const linked = derivePrices(sale).min;
  const minInput = tr.querySelector("input.input-pret-minim");
  if (minInput) {
    minInput.value =
      linked == null || !Number.isFinite(Number(linked)) ? "" : String(linked);
  }
  applyRowPrices(tr, sale);
  updateToolbarTotals();
  schedulePersistPretMinim(tr.dataset.offerId, null);
});

/* ---------- Persistare in DB (sursa de adevar) ---------- */

const persistTimers = new Map();

/** Salveaza un subset de campuri pe listing-ul canalului curent. */
async function patchListing(offerId, fields) {
  const id = String(offerId ?? "").trim();
  if (!id) return null;
  const res = await fetch(
    `/api/catalog/listing/${encodeURIComponent(id)}?channel=${encodeURIComponent(currentChannel)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.listing || null;
}

/** Debounce per (oferta, camp) — ultima valoare tastata castiga. */
function schedulePersistListing(offerId, fields, label) {
  const id = String(offerId ?? "");
  if (!id) return;
  const key = `${id}:${Object.keys(fields).sort().join(",")}`;
  const prev = persistTimers.get(key);
  if (prev) clearTimeout(prev);
  persistTimers.set(
    key,
    setTimeout(async () => {
      persistTimers.delete(key);
      try {
        await patchListing(id, fields);
        patchLoadedProduct(id, fields);
      } catch (err) {
        console.error(`[${label || "listing"}] salvare eșuată:`, err.message);
        setStatus(err.message || "Eroare la salvare", "error");
      }
    }, 300)
  );
}

function patchLoadedProduct(id, fields) {
  const idx = loadedProducts.findIndex((p) => String(p.id) === String(id));
  if (idx === -1) return;
  loadedProducts[idx] = { ...loadedProducts[idx], ...fields };
}

const numOrNull = (v) =>
  v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v);

function schedulePersistAlteCosturi(offerId, value) {
  schedulePersistListing(offerId, { alte_costuri: numOrNull(value) }, "alte-costuri");
}

function schedulePersistPretCumparare(offerId, value) {
  schedulePersistListing(offerId, { pret_cumparare: numOrNull(value) }, "pret-cumparare");
}

function schedulePersistPretContabil(offerId, value) {
  schedulePersistListing(offerId, { pret_contabil: numOrNull(value) }, "pret-contabil");
}

function schedulePersistPretMinim(offerId, value) {
  schedulePersistListing(
    offerId,
    { pret_minim_override: numOrNull(value) },
    "pret-minim"
  );
}

function schedulePersistProcentajEmag(offerId, value) {
  schedulePersistListing(offerId, { procentaj_emag: numOrNull(value) }, "procentaj-emag");
}

function schedulePersistSalePrice(offerId, value) {
  schedulePersistListing(offerId, { sale_price: numOrNull(value) }, "pret");
}

function schedulePersistStock(offerId, stockArr) {
  schedulePersistListing(offerId, { stock: stockArr }, "stoc");
}

function schedulePersistName(offerId, value) {
  schedulePersistListing(offerId, { name: String(value ?? "") }, "nume");
}

function schedulePersistDescription(offerId, value) {
  schedulePersistListing(offerId, { description: String(value ?? "") }, "descriere");
}

/** Preturile derivate (PRP/min/max) se recalculeaza in UI — le salvez odata cu pretul. */
function schedulePersistDerived(tr) {
  const offerId = tr?.dataset?.offerId;
  if (!offerId) return;
  const prp = tr.querySelector("td[data-col='prp']")?.dataset.value;
  const max = tr.querySelector("td[data-col='pret_maxim']")?.dataset.value;
  const min = tr.querySelector("td[data-col='pret_minim']")?.dataset.value;
  schedulePersistListing(
    offerId,
    {
      recommended_price: numOrNull(prp),
      max_sale_price: numOrNull(max),
      min_sale_price: numOrNull(min),
    },
    "preturi-derivate"
  );
}

function collectCommissionFetchItems() {
  return [...tbody.querySelectorAll("tr[data-offer-id]")].map((tr) => {
    const saleInput = tr.querySelector("input.input-sale-price");
    const sale =
      saleInput?.value !== "" && saleInput?.value != null
        ? saleInput.value
        : tr.dataset.originalSale ?? "";
    return {
      id: Number(tr.dataset.offerId),
      sale_price: Number(sale),
    };
  }).filter((item) => Number.isFinite(item.id));
}

function applyCommissionResultToRow(tr, result) {
  tr.dataset.emagPct = String(result.procentaj_emag);
  tr.dataset.emagCommissionValue = String(result.commission_value);
  tr.dataset.emagCommissionFetchedAt = result.fetched_at ?? "";
  syncProcentajEmagCell(
    tr,
    result.procentaj_emag,
    result.commission_value,
    result.fetched_at
  );
  const saleInput = tr.querySelector("input.input-sale-price");
  applyRowPrices(tr, saleInput?.value ?? tr.dataset.originalSale ?? "");
}

async function fetchCommissionForLoadedProducts() {
  if (fetchingCommission) return;
  const items = collectCommissionFetchItems();
  if (!items.length) {
    setStatus("Niciun produs încărcat.", "error");
    return;
  }

  fetchingCommission = true;
  if (btnFetchCommission) btnFetchCommission.disabled = true;
  setStatus(`Preiau comision eMAG (0/${items.length})…`, "loading");

  try {
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

    const byId = new Map((data.results || []).map((r) => [String(r.id), r]));
    for (const tr of tbody.querySelectorAll("tr[data-offer-id]")) {
      const result = byId.get(tr.dataset.offerId);
      if (result) {
        applyCommissionResultToRow(tr, result);
        patchLoadedProductCommission(result.id, result);
      }
    }

    updateToolbarTotals();
    const errCount = data.errorCount || 0;
    setStatus(
      errCount
        ? `Comision preluat: ${data.count}/${items.length} (${errCount} erori).`
        : `Comision preluat pentru ${data.count} produse.`,
      errCount ? "error" : "ok"
    );
  } catch (err) {
    setStatus(err.message || "Eroare la preluare comision", "error");
  } finally {
    fetchingCommission = false;
    if (btnFetchCommission) btnFetchCommission.disabled = false;
  }
}

/* ---------- Export Excel ---------- */

const EXPORT_NUMERIC_COLS = new Set([
  "index",
  "id",
  "id_familie",
  "pret_cumparare",
  "alte_costuri",
  "pret_contabil",
  "procentaj_emag",
  "pret_minim_profit",
  "pret_emag",
  "profit",
  "procentaj_profit",
  "prp",
  "pret_minim",
  "pret_maxim",
  "stoc",
]);

function toExportValue(col, text) {
  const raw = String(text ?? "").trim();
  if (!raw || raw === "—") return null;
  if (!EXPORT_NUMERIC_COLS.has(col)) return raw;

  const cleaned = raw
    .replace(/[^\d,.\-]/g, "")
    .replace(/\.(?=\d{3}\b)/g, "")
    .replace(",", ".");
  const num = Number(cleaned);
  return Number.isFinite(num) && cleaned !== "" ? num : raw;
}

function collectExportRows(mode) {
  const cols =
    mode === "all" ? [...columnOrder] : columnOrder.filter((c) => !hiddenCols.includes(c));
  const allRows = [...tbody.querySelectorAll("tr[data-offer-id]")];
  const rows = mode === "all" ? allRows : allRows.filter((tr) => !tr.classList.contains("is-row-filtered"));

  return {
    cols,
    headers: cols.map((col) => COLUMN_LABELS[col] || col),
    rows: rows.map((tr) => cols.map((col) => toExportValue(col, getCellFilterText(tr, col)))),
  };
}

function filenameFromDisposition(disposition, fallback) {
  const match = /filename="?([^";]+)"?/i.exec(disposition || "");
  return match ? match[1] : fallback;
}

async function exportProducts(mode) {
  if (exporting) return;
  const { headers, rows } = collectExportRows(mode);
  if (!headers.length || rows.length === 0) {
    setStatus("Nimic de exportat.", "error");
    return;
  }

  exporting = true;
  if (btnExport) btnExport.disabled = true;
  if (btnExportMenu) btnExportMenu.disabled = true;
  setStatus("Se generează Excel...", "loading");

  try {
    const res = await fetch("/api/products/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headers, rows, mode }),
    });
    if (!res.ok) {
      let message = `Eroare export (${res.status})`;
      try {
        const data = await res.json();
        if (data?.error) message = data.error;
      } catch {}
      throw new Error(message);
    }

    const blob = await res.blob();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const name = filenameFromDisposition(
      res.headers.get("Content-Disposition"),
      `produse-emag-${stamp}.xlsx`
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    setStatus(`Export finalizat (${rows.length} produse).`, "ok");
  } catch (err) {
    setStatus(err.message || "Eroare la export", "error");
  } finally {
    exporting = false;
    if (btnExport) btnExport.disabled = false;
    if (btnExportMenu) btnExportMenu.disabled = false;
  }
}

function setExportMenuOpen(open) {
  if (!exportMenu || !btnExportMenu) return;
  exportMenu.hidden = !open;
  btnExportMenu.setAttribute("aria-expanded", open ? "true" : "false");
}

btnExport?.addEventListener("click", () => exportProducts("visible"));

btnExportMenu?.addEventListener("click", (e) => {
  e.stopPropagation();
  setExportMenuOpen(exportMenu.hidden);
});

exportMenu?.addEventListener("click", (e) => {
  e.stopPropagation();
  const item = e.target.closest("[data-export-mode]");
  if (!item) return;
  setExportMenuOpen(false);
  exportProducts(item.dataset.exportMode);
});

btnSaveSettings.addEventListener("click", saveSettings);
btnLoad.addEventListener("click", () => loadProducts());
btnPull?.addEventListener("click", pullFromChannel);
btnMore.hidden = true;
channelSelect?.addEventListener("change", () => {
  currentChannel = channelSelect.value || "emag";
  try {
    localStorage.setItem(CHANNEL_KEY, currentChannel);
  } catch {
    /* ignore */
  }
  loadProducts();
});
btnFetchCommission?.addEventListener("click", fetchCommissionForLoadedProducts);
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

inputProcentajAlte.addEventListener("input", onSettingsInput);
inputProcentajContabil.addEventListener("input", onSettingsInput);
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
  if (exportMenu && !exportMenu.hidden) setExportMenuOpen(false);
});

applyColumnOrder();
buildColumnMenu();
applyColumnVisibility();
updateSyncButton();
if (channelSelect) channelSelect.value = currentChannel;
loadSettings().then(() => loadProducts());

/* ---------- Istoric preț + comenzi (modal) ---------- */

const ORDER_STATUS_LABELS = {
  0: "Anulat",
  1: "Nou",
  2: "În progres",
  3: "Preparat",
  4: "Finalizat",
  5: "Returnat",
};

const historyModal = document.getElementById("history-modal");
const historyModalTitle = document.getElementById("history-modal-title");
const historyModalSub = document.getElementById("history-modal-sub");
const historyChart = document.getElementById("history-chart");
const historyChartTooltip = document.getElementById("history-chart-tooltip");
const historyOrdersBody = document.getElementById("history-orders-body");

function orderStatusLabel(status) {
  const n = Number(status);
  return ORDER_STATUS_LABELS[n] ?? (status == null ? "—" : String(status));
}

function svgEl(name, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs || {})) {
    el.setAttribute(k, String(v));
  }
  return el;
}

// Step-chart: pretul se mentine constant intre schimbari.
function renderPriceChart(svg, points) {
  svg.innerHTML = "";
  const W = 720;
  const H = 260;
  const pad = { top: 20, right: 20, bottom: 34, left: 56 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const pts = (points || [])
    .map((p) => ({ t: Date.parse(p.recorded_at), y: Number(p.sale_price) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.y))
    .sort((a, b) => a.t - b.t);

  if (pts.length === 0) {
    svg.appendChild(
      svgEl("text", {
        x: W / 2,
        y: H / 2,
        "text-anchor": "middle",
        class: "chart-empty-text",
      })
    ).textContent = "Fără istoric de preț încă.";
    return;
  }

  // Extinde ultimul punct pana la "acum" ca sa vedem cat timp a stat pretul.
  const now = Date.now();
  const tMin = pts[0].t;
  const tMax = Math.max(pts[pts.length - 1].t, now);
  const tSpan = tMax - tMin || 1;
  const yVals = pts.map((p) => p.y);
  let yMin = Math.min(...yVals);
  let yMax = Math.max(...yVals);
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const yPad = (yMax - yMin) * 0.12;
  yMin -= yPad;
  yMax += yPad;
  const ySpan = yMax - yMin || 1;

  const sx = (t) => pad.left + ((t - tMin) / tSpan) * plotW;
  const sy = (y) => pad.top + (1 - (y - yMin) / ySpan) * plotH;

  // Axe.
  svg.appendChild(
    svgEl("line", {
      x1: pad.left,
      y1: pad.top + plotH,
      x2: pad.left + plotW,
      y2: pad.top + plotH,
      class: "chart-axis",
    })
  );
  svg.appendChild(
    svgEl("line", {
      x1: pad.left,
      y1: pad.top,
      x2: pad.left,
      y2: pad.top + plotH,
      class: "chart-axis",
    })
  );

  // Grilaj + etichete Y (3 nivele).
  for (let i = 0; i <= 2; i++) {
    const y = yMin + (ySpan * i) / 2;
    const py = sy(y);
    svg.appendChild(
      svgEl("line", {
        x1: pad.left,
        y1: py,
        x2: pad.left + plotW,
        y2: py,
        class: "chart-grid",
      })
    );
    const label = svgEl("text", {
      x: pad.left - 8,
      y: py + 4,
      "text-anchor": "end",
      class: "chart-tick",
    });
    label.textContent = y.toFixed(2);
    svg.appendChild(label);
  }

  // Etichete X (prima + ultima data).
  const fmtDate = (t) => new Date(t).toLocaleDateString("ro-RO");
  const xFirst = svgEl("text", {
    x: pad.left,
    y: H - 12,
    "text-anchor": "start",
    class: "chart-tick",
  });
  xFirst.textContent = fmtDate(tMin);
  svg.appendChild(xFirst);
  const xLast = svgEl("text", {
    x: pad.left + plotW,
    y: H - 12,
    "text-anchor": "end",
    class: "chart-tick",
  });
  xLast.textContent = fmtDate(tMax);
  svg.appendChild(xLast);

  // Linie in trepte.
  let d = "";
  pts.forEach((p, i) => {
    const x = sx(p.t);
    const y = sy(p.y);
    if (i === 0) {
      d += `M ${x} ${y}`;
    } else {
      const prevY = sy(pts[i - 1].y);
      d += ` L ${x} ${prevY} L ${x} ${y}`;
    }
  });
  // Prelungeste orizontal pana la tMax (acum).
  d += ` L ${sx(tMax)} ${sy(pts[pts.length - 1].y)}`;
  svg.appendChild(svgEl("path", { d, class: "chart-line", fill: "none" }));

  // Markeri la fiecare schimbare + hover.
  pts.forEach((p) => {
    const cx = sx(p.t);
    const cy = sy(p.y);
    const dot = svgEl("circle", { cx, cy, r: 4, class: "chart-dot" });
    dot.addEventListener("mouseenter", () => {
      historyChartTooltip.hidden = false;
      historyChartTooltip.textContent = `${p.y.toFixed(2)} RON · ${new Date(
        p.t
      ).toLocaleString("ro-RO")}`;
      const rect = svg.getBoundingClientRect();
      const scaleX = rect.width / W;
      const scaleY = rect.height / H;
      historyChartTooltip.style.left = `${cx * scaleX}px`;
      historyChartTooltip.style.top = `${cy * scaleY - 12}px`;
    });
    dot.addEventListener("mouseleave", () => {
      historyChartTooltip.hidden = true;
    });
    svg.appendChild(dot);
  });
}

function renderHistoryOrders(orders) {
  const list = Array.isArray(orders) ? orders : [];
  if (list.length === 0) {
    historyOrdersBody.innerHTML =
      '<tr><td colspan="5" class="history-orders-empty">Nicio comandă înregistrată pentru acest produs.</td></tr>';
    return;
  }
  historyOrdersBody.innerHTML = list
    .map((o) => {
      const date = o.order_date
        ? escapeHtml(new Date(o.order_date).toLocaleString("ro-RO"))
        : "—";
      return `<tr>
        <td>${date}</td>
        <td>${escapeHtml(o.order_id ?? "—")}</td>
        <td>${escapeHtml(o.quantity ?? "—")}</td>
        <td>${formatPrice(o.sale_price, o.currency || "RON")}</td>
        <td>${escapeHtml(orderStatusLabel(o.status))}</td>
      </tr>`;
    })
    .join("");
}

function priceHistorySummary(history) {
  const list = Array.isArray(history) ? history : [];
  if (list.length === 0) return "Fără schimbări de preț înregistrate încă.";
  const last = list[list.length - 1];
  const rel = relativeTimeRo(last.recorded_at);
  const count = list.length;
  return `${count} ${count === 1 ? "înregistrare" : "înregistrări"} · ultima schimbare ${rel} (${formatPrice(
    last.sale_price,
    last.currency || "RON"
  )})`;
}

function openHistoryModal(offerId, name) {
  historyModalTitle.textContent = name
    ? `Istoric — ${name}`
    : `Istoric preț — #${offerId}`;
  historyModalSub.textContent = "Se încarcă…";
  historyChart.innerHTML = "";
  historyOrdersBody.innerHTML = "";
  historyChartTooltip.hidden = true;
  historyModal.hidden = false;
  document.body.classList.add("modal-open");

  fetch(`/api/products/${encodeURIComponent(offerId)}/history`)
    .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || "Eroare istoric");
      historyModalSub.textContent = priceHistorySummary(data.price_history);
      renderPriceChart(historyChart, data.price_history);
      renderHistoryOrders(data.orders);
    })
    .catch((err) => {
      historyModalSub.textContent = err.message || "Eroare la încărcare istoric";
    });
}

function closeHistoryModal() {
  historyModal.hidden = true;
  historyChartTooltip.hidden = true;
  document.body.classList.remove("modal-open");
}

historyModal.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeHistoryModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !historyModal.hidden) closeHistoryModal();
});
