const btnLoad = document.getElementById("btn-load");
const btnMore = document.getElementById("btn-more");
const btnSaveSettings = document.getElementById("btn-save-settings");
const btnSync = document.getElementById("btn-sync");
const btnColumns = document.getElementById("btn-columns");
const colMenu = document.getElementById("col-menu");
const statusEl = document.getElementById("status");
const syncInfoBanner = document.getElementById("sync-info-banner");
const tbody = document.getElementById("products-body");
const table = document.getElementById("products-table");
const inputProcentaj = document.getElementById("procentaj-emag");
const inputMultPrp = document.getElementById("mult-prp");
const inputMultMin = document.getElementById("mult-min");
const inputMultMax = document.getElementById("mult-max");

const HIDDEN_COLS_KEY = "emag-hidden-columns";
const COL_ORDER_KEY = "emag-column-order";
const DEFAULT_ALTE_COSTURI = 12;

const DEFAULT_COLUMN_ORDER = [
  ...table.querySelectorAll("thead th[data-col]"),
].map((th) => th.dataset.col);
const COLUMN_LABELS = Object.fromEntries(
  [...table.querySelectorAll("thead th[data-col]")].map((th) => [
    th.dataset.col,
    th.textContent.trim(),
  ])
);

let currentPage = 1;
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
  const OLD = new Set(["pret_transport", "pret_contabil"]);
  const out = [];
  let insertedAlte = false;
  for (const c of cols) {
    if (OLD.has(c)) {
      if (!insertedAlte) {
        out.push("alte_costuri");
        insertedAlte = true;
      }
      continue;
    }
    out.push(c);
  }
  return out;
}

function loadHiddenCols() {
  try {
    const raw = localStorage.getItem(HIDDEN_COLS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const migrated = migrateLegacyCostCols(
      parsed.filter((c) => typeof c === "string")
    );
    // If both old cols were hidden, keep alte_costuri hidden; if only one, still hide.
    const hadLegacyHidden = parsed.some(
      (c) => c === "pret_transport" || c === "pret_contabil"
    );
    if (hadLegacyHidden && !migrated.includes("alte_costuri")) {
      migrated.push("alte_costuri");
    }
    return migrated.filter((c) => c !== "pret_transport" && c !== "pret_contabil");
  } catch {
    return [];
  }
}

function saveHiddenCols() {
  localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify(hiddenCols));
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
    const order = migrated.filter((c) => valid.has(c));
    for (const col of DEFAULT_COLUMN_ORDER) {
      if (!order.includes(col)) order.push(col);
    }
    return order;
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

function applyColumnOrder() {
  const headerRow = table.querySelector("thead tr");
  if (!headerRow) return;
  const thByCol = Object.fromEntries(
    [...headerRow.querySelectorAll("th[data-col]")].map((th) => [th.dataset.col, th])
  );
  columnOrder.forEach((col) => {
    if (thByCol[col]) headerRow.appendChild(thByCol[col]);
  });

  tbody.querySelectorAll("tr:not(.empty-row)").forEach((tr) => {
    const tdByCol = Object.fromEntries(
      [...tr.querySelectorAll("td[data-col]")].map((td) => [td.dataset.col, td])
    );
    columnOrder.forEach((col) => {
      if (tdByCol[col]) tr.appendChild(tdByCol[col]);
    });
  });
}

function buildColumnMenu() {
  colMenu.innerHTML = columnOrder
    .map((col) => {
      const checked = !hiddenCols.includes(col) ? "checked" : "";
      const label = COLUMN_LABELS[col] || col;
      return `<div class="col-menu-item" data-col="${escapeHtml(col)}">
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
  inputMultPrp.value = settings.mult_prp != null ? settings.mult_prp : "";
  inputMultMin.value = settings.mult_min != null ? settings.mult_min : "";
  inputMultMax.value = settings.mult_max != null ? settings.mult_max : "";
  snapshotSettings();
}

function readSettingsFromForm() {
  return {
    procentaj_emag: inputProcentaj.value,
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

function getRowAlteCosturi(tr) {
  const input = tr?.querySelector("input.input-alte-costuri");
  return parseAlteCosturi(input?.value);
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
  const alteCell = tr.querySelector("td[data-col='alte_costuri']");
  const original = tr.dataset.originalSale ?? "";
  const isDirty =
    markDirty &&
    (!pricesEqual(salePrice, original) ||
      (derived.prp != null && !pricesEqual(derived.prp, tr.dataset.originalPrp)) ||
      (derived.min != null && !pricesEqual(derived.min, tr.dataset.originalMin)) ||
      (derived.max != null && !pricesEqual(derived.max, tr.dataset.originalMax)) ||
      !pricesEqual(alteCosturi, tr.dataset.originalAlte));
  tr.classList.toggle("is-price-dirty", isDirty);
  if (pretCell) pretCell.classList.toggle("is-price-dirty", isDirty);
  if (prpCell) prpCell.classList.toggle("is-price-dirty", isDirty);
  if (minCell) minCell.classList.toggle("is-price-dirty", isDirty);
  if (maxCell) maxCell.classList.toggle("is-price-dirty", isDirty);
  if (alteCell) alteCell.classList.toggle("is-price-dirty", isDirty);

  if (isDirty) {
    tr.classList.remove("is-just-synced");
    if (pretCell) pretCell.classList.remove("is-just-synced");
    if (prpCell) prpCell.classList.remove("is-just-synced");
    if (minCell) minCell.classList.remove("is-just-synced");
    if (maxCell) maxCell.classList.remove("is-just-synced");
    if (alteCell) alteCell.classList.remove("is-just-synced");
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
  const alteCosturi = DEFAULT_ALTE_COSTURI;
  const minProfit = calcPretMinimProfit(pretCumparare, alteCosturi);
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
    alteCosturi
  );
  const procentajAttr =
    procentajVal == null || !Number.isFinite(Number(procentajVal))
      ? ""
      : Number(procentajVal).toFixed(2);
  const procentajExtra = ["col-procentaj-profit", procentajLevelClass(procentajVal)]
    .filter(Boolean)
    .join(" ");
  const stockJson = escapeHtml(JSON.stringify(product.stock ?? [{ warehouse_id: 1, value: 0 }]));
  const handlingJson = escapeHtml(
    JSON.stringify(product.handling_time ?? [{ warehouse_id: 1, value: 0 }])
  );
  const cells = {
    index: `<td data-col="index"${cellClass("index")}>${index}</td>`,
    id: `<td data-col="id"${cellClass("id")}>${escapeHtml(product.id)}</td>`,
    name: `<td data-col="name"${cellClass("name")}>${escapeHtml(product.name) || "—"}</td>`,
    part_number: `<td data-col="part_number"${cellClass("part_number")}>${escapeHtml(product.part_number) || "—"}</td>`,
    id_familie: `<td data-col="id_familie"${cellClass("id_familie")}>${escapeHtml(product.id_familie) || "—"}</td>`,
    familie: `<td data-col="familie"${cellClass("familie")}>${escapeHtml(product.familie) || "—"}</td>`,
    pret_cumparare: `<td data-col="pret_cumparare"${cellClass("pret_cumparare")}>${formatPrice(product.pret_cumparare, "RON")}</td>`,
    alte_costuri: `<td data-col="alte_costuri"${cellClass("alte_costuri", "col-alte-costuri")}><input type="number" class="input-alte-costuri" min="0" step="0.01" value="${DEFAULT_ALTE_COSTURI}" /></td>`,
    pret_minim_profit: `<td data-col="pret_minim_profit"${cellClass("pret_minim_profit", minProfitExtra)}>${formatPrice(minProfit, currency)}</td>`,
    pret_emag: `<td data-col="pret_emag"${cellClass("pret_emag", "col-pret-emag")}><input type="number" class="input-sale-price" min="0" step="0.01" value="${escapeHtml(saleAttr)}" /></td>`,
    profit: `<td data-col="profit"${cellClass("profit", "col-profit")} data-sale-price="${escapeHtml(salePrice)}" data-pret-cumparare="${escapeHtml(pretCumparare)}" data-currency="${escapeHtml(currency)}">${formatPrice(calcProfit(product.sale_price, product.pret_cumparare, alteCosturi), currency)}</td>`,
    procentaj_profit: `<td data-col="procentaj_profit"${cellClass("procentaj_profit", procentajExtra)}><input type="number" class="input-procentaj-profit" step="0.01" value="${escapeHtml(procentajAttr)}" /></td>`,
    prp: `<td data-col="prp"${cellClass("prp", prpExtra)} data-value="${escapeHtml(product.recommended_price ?? "")}">${formatPrice(product.recommended_price, currency)}</td>`,
    pret_minim: `<td data-col="pret_minim"${cellClass("pret_minim")} data-value="${escapeHtml(product.min_sale_price ?? "")}">${formatPrice(product.min_sale_price, currency)}</td>`,
    pret_maxim: `<td data-col="pret_maxim"${cellClass("pret_maxim")} data-value="${escapeHtml(product.max_sale_price ?? "")}">${formatPrice(product.max_sale_price, currency)}</td>`,
    stoc: `<td data-col="stoc"${cellClass("stoc")}>${escapeHtml(product.general_stock ?? "—")}</td>`,
    status: `<td data-col="status"${cellClass("status")}>${formatStatus(product.status)}</td>`,
    ean_pnk: `<td data-col="ean_pnk"${cellClass("ean_pnk")}>${eanPnk(product)}</td>`,
  };
  return `<tr data-offer-id="${escapeHtml(product.id)}" data-original-sale="${escapeHtml(salePrice)}" data-pret-cumparare="${escapeHtml(pretCumparare)}" data-currency="${escapeHtml(currency)}" data-original-prp="${escapeHtml(product.recommended_price ?? "")}" data-original-min="${escapeHtml(product.min_sale_price ?? "")}" data-original-max="${escapeHtml(product.max_sale_price ?? "")}" data-original-alte="${DEFAULT_ALTE_COSTURI}" data-status="${escapeHtml(product.status ?? "")}" data-vat-id="${escapeHtml(product.vat_id ?? "")}" data-stock="${stockJson}" data-handling-time="${handlingJson}">
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
  if (
    col === "index" ||
    col === "id" ||
    col === "stoc" ||
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
  table.querySelectorAll("thead th[data-col]").forEach((th) => {
    th.classList.remove("is-sorted-asc", "is-sorted-desc");
    if (sortCol && th.dataset.col === sortCol) {
      th.classList.add(sortDir === "asc" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortDir === "asc" ? "ascending" : "descending");
    } else {
      th.setAttribute("aria-sort", "none");
    }
  });
}

function sortProductsTable() {
  updateSortHeaders();
  if (!sortCol) return;

  const rows = [...tbody.querySelectorAll("tr:not(.empty-row)")];
  if (rows.length === 0) return;

  rows.sort((a, b) => compareRows(a, b, sortCol, sortDir));
  rows.forEach((tr, i) => {
    tbody.appendChild(tr);
    const indexCell = tr.querySelector('td[data-col="index"]');
    if (indexCell) indexCell.textContent = String(i + 1);
  });
}

function renderProducts(products, append) {
  if (!append) {
    tbody.innerHTML = "";
  }

  if (!append && products.length === 0) {
    tbody.innerHTML =
      '<tr class="empty-row"><td colspan="18">Niciun produs găsit.</td></tr>';
    updateSyncButton();
    return;
  }

  const empty = tbody.querySelector(".empty-row");
  if (empty) empty.remove();

  const startIndex = tbody.querySelectorAll("tr:not(.empty-row)").length + 1;
  tbody.insertAdjacentHTML(
    "beforeend",
    products.map((p, i) => rowHtml(p, startIndex + i)).join("")
  );
  if (sortCol) sortProductsTable();
  updateSyncButton();
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

    currentPage = data.page;
    renderProducts(data.products, append);

    const totalShown = tbody.querySelectorAll("tr:not(.empty-row)").length;
    setStatus(`Afișate ${totalShown} produse (pagina ${data.page}).`, "ok");

    btnMore.hidden = !data.hasMore;
  } catch (err) {
    setStatus(err.message || "Eroare la încărcare", "error");
    if (!append) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="18">${escapeHtml(
        err.message || "Eroare"
      )}</td></tr>`;
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

    const stock = parseJsonAttr(tr.dataset.stock, [{ warehouse_id: 1, value: 0 }]);
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
  if (pretCell) pretCell.classList.add("is-just-synced");
  if (prpCell) prpCell.classList.add("is-just-synced");
  if (minCell) minCell.classList.add("is-just-synced");
  if (maxCell) maxCell.classList.add("is-just-synced");
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
    tr.dataset.originalAlte = String(getRowAlteCosturi(tr));
    applyRowPrices(tr, offer.sale_price, { markDirty: true });
    markJustSynced(tr);
  });
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
    setStatus("Nicio schimbare de preț de sincronizat.", "error");
    return;
  }

  syncing = true;
  btnSync.disabled = true;
  setStatus(`Se sincronizează ${offers.length} prețuri…`, "loading");
  console.log(
    `[eMAG sync] trimit ${offers.length} oferte:`,
    offers.map((o) => ({
      id: o.id,
      sale_price: o.sale_price,
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
      `Sincronizate ${offers.length} prețuri cu eMAG.` +
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
    return;
  }

  const alteInput = e.target.closest("input.input-alte-costuri");
  if (alteInput) {
    const tr = alteInput.closest("tr[data-offer-id]");
    if (!tr) return;
    const saleInput = tr.querySelector("input.input-sale-price");
    applyRowPrices(tr, saleInput?.value ?? "");
    return;
  }

  const input = e.target.closest("input.input-sale-price");
  if (!input) return;
  const tr = input.closest("tr[data-offer-id]");
  if (!tr) return;
  applyRowPrices(tr, input.value);
});

btnSaveSettings.addEventListener("click", saveSettings);
btnLoad.addEventListener("click", () => loadProducts({ append: false }));
btnMore.addEventListener("click", () => loadProducts({ append: true }));
btnSync.addEventListener("click", syncPrices);

table.querySelector("thead")?.addEventListener("click", (e) => {
  const th = e.target.closest("th[data-col]");
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

function onSettingsInput() {
  updateDerivedCells();
  updateSaveDirtyState();
}

inputProcentaj.addEventListener("input", onSettingsInput);
inputMultPrp.addEventListener("input", onSettingsInput);
inputMultMin.addEventListener("input", onSettingsInput);
inputMultMax.addEventListener("input", onSettingsInput);

btnColumns.addEventListener("click", (e) => {
  e.stopPropagation();
  setColumnMenuOpen(colMenu.hidden);
});

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
loadSettings();
