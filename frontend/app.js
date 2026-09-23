/* Calculele si formatarile comune stau in pricing.js (incarcat inaintea acestui fisier). */
const {
  DEFAULT_PROcentaj_EMAG,
  escapeHtml,
  formatPrice,
  formatPercent,
  relativeTimeRo,
  stalenessClass,
  numOrNull,
  parseJsonAttr,
  parseSortNumber,
  roundPrice,
  pricesEqual,
  stockSumFromArr,
  createPersister,
} = window.Pricing;
/* Formulele din "CALCULATOR INFINITE VENTURES.xlsx" (servite de backend la /api/calculator.js). */
const Calc = window.Calculator;

const btnMore = document.getElementById("btn-more");
const btnSaveSettings = document.getElementById("btn-save-settings");
const btnColumns = document.getElementById("btn-columns");
const btnExport = document.getElementById("btn-export");
const btnExportMenu = document.getElementById("btn-export-menu");
const exportMenu = document.getElementById("export-menu");
const btnTableFullscreen = document.getElementById("btn-table-fullscreen");
const btnCompactProducts = document.getElementById("btn-compact-products");
const btnPushAll = document.getElementById("btn-sync");
const colMenu = document.getElementById("col-menu");
const statusEl = document.getElementById("status");
const tbody = document.getElementById("products-body");
const table = document.getElementById("products-table");
const productsWrap = document.getElementById("products-wrap");
const pageEl = document.querySelector(".page");
const inputMultPrp = document.getElementById("mult-prp");
const inputMultMin = document.getElementById("mult-min");
const inputMultMax = document.getElementById("mult-max");
const calcParamInputs = [...document.querySelectorAll("[data-calc-param]")];
const calcRegimSelect = document.getElementById("calc-regim");
const calcAerRon = document.getElementById("calc-aer-ron");
const calcTrenRon = document.getElementById("calc-tren-ron");
const calcParamsSummary = document.getElementById("calc-params-summary");
const orderHistoryModal = document.getElementById("order-history-modal");
const orderHistoryClose = document.getElementById("order-history-close");
const orderHistoryBody = document.getElementById("order-history-body");
const orderHistoryProduct = document.getElementById("order-history-product");

const HIDDEN_COLS_KEY = "emag-hidden-columns";
const COL_ORDER_KEY = "emag-column-order";
const TABLE_FULLSCREEN_KEY = "emag-table-fullscreen";
const COMPACT_PRODUCTS_KEY = "emag-compact-products";
/* Pagina de produse: editor peste DB-ul local; datele stau in catalog_products (SoT). */
const LISTING_CHANNEL = "emag";

let currentPage = 1;
let hasMore = false;
/** @type {Array<object>} */
let loadedProducts = [];
let loading = false;
let savingSettings = false;
let exporting = false;
let savedSettingsSnapshot = null;
let sortCol = null;
let sortDir = "asc";

/** "Pret transport" (transport_override, fost pret_transport/alte_costuri) a fost inlocuit de calculator. */
function migrateLegacyCostCols(cols) {
  const REMOVED = new Set([
    "procentaj_alte_costuri",
    "pret_transport",
    "alte_costuri",
    "transport_override",
  ]);
  const out = [];
  for (const c of cols) {
    if (REMOVED.has(c) || out.includes(c)) continue;
    out.push(c);
  }
  return out;
}

const columns = window.TableColumns.create({
  table,
  tbody,
  menuEl: colMenu,
  buttonEl: btnColumns,
  hiddenKey: HIDDEN_COLS_KEY,
  orderKey: COL_ORDER_KEY,
  widthsKey: "emag-column-widths",
  migrate: migrateLegacyCostCols,
  onVisibilityChange: () => markPresetCustom(),
});

/* ---------- Preseturi de coloane ---------- */

const colPresetSelect = document.getElementById("col-preset");
const btnColPresetDelete = document.getElementById("btn-col-preset-delete");
const COL_PRESET_KEY = "emag-column-preset";
const CUSTOM_PRESETS_KEY = "emag-column-presets-custom";
const PRESET_BASE = ["index", "images", "part_number"];

/** Coloanele vizibile pentru fiecare preset; restul se ascund. Ordinea ramane cea din tabel, cu exceptia presetelor `ordered`. */
const BUILTIN_PRESETS = [
  { id: "toate", label: "Toate coloanele", cols: null },
  {
    id: "texte",
    label: "Titluri și descrieri",
    cols: [...PRESET_BASE, "id", "name", "description", "familie", "ean", "pnk"],
  },
  {
    id: "preturi",
    label: "Prețuri și profit",
    cols: [
      ...PRESET_BASE,
      "order_history",
      "pret_cumparare",
      "pret_emag",
      "procentaj_emag",
      "profit_tren",
      "procent_profit_tren",
      "profit_aer",
      "procent_profit_aer",
      "break_even_tren",
      "break_even_aer",
      "stoc",
    ],
  },
  {
    id: "calculator",
    label: "Calculator (Excel)",
    /** Ordinea coloanelor din fisierul Excel CALCULATOR INFINITE VENTURES. */
    ordered: true,
    cols: [
      "index",
      "name",
      "images",
      "part_number",
      "moneda_fabrica",
      "pret_cumparare_usd",
      "pret_achiz_china",
      "greutate",
      "greutate_volumetrica",
      "transport_aer",
      "transport_tren",
      "taxe_vamale_aer",
      "taxe_vamale_tren",
      "tva_import_aer",
      "tva_import_tren",
      "cost_final_aer",
      "cost_final_tren",
      "diferenta_aer_tren",
      "cat_salvezi",
      "pret_cumparare",
      "pret_emag",
      "procentaj_emag",
      "pret_vanzare_fara_tva",
      "comision_valoare",
      "comision_tva",
      "impozit_aer",
      "impozit_tren",
      "tva_colectat_aer",
      "tva_colectat_tren",
      "profit_aer",
      "procent_profit_aer",
      "profit_tren",
      "procent_profit_tren",
      "break_even_aer",
      "break_even_tren",
      "nr_bucati",
      "cost_comanda_aer",
      "cost_comanda_tren",
      "link_emag",
      "link_cumparare",
      "link_ali",
      "link_amz",
      "ce",
      "decizie",
    ],
  },
  {
    id: "dimensiuni",
    label: "Greutate și dimensiuni",
    cols: [
      ...PRESET_BASE,
      "greutate",
      "greutate_volumetrica",
      "inaltime",
      "lungime",
      "latime",
      "transport_aer",
      "transport_tren",
    ],
  },
  {
    id: "aprovizionare",
    label: "Aprovizionare (stoc, linkuri, decizie)",
    cols: [
      ...PRESET_BASE,
      "order_history",
      "stoc",
      "moneda_fabrica",
      "pret_cumparare_usd",
      "profit_tren",
      "procent_profit_tren",
      "nr_bucati",
      "cost_comanda_aer",
      "cost_comanda_tren",
      "link_emag",
      "link_cumparare",
      "link_ali",
      "link_amz",
      "ce",
      "decizie",
    ],
  },
];

const colPresets = window.TableColumns.createPresets({
  columns,
  selectEl: colPresetSelect,
  deleteBtn: btnColPresetDelete,
  presetKey: COL_PRESET_KEY,
  customKey: CUSTOM_PRESETS_KEY,
  builtins: BUILTIN_PRESETS,
  onSaved: () => setStatus("Preset salvat.", "ok"),
});

function markPresetCustom() {
  colPresets.markCustom();
}

function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (type ? ` is-${type}` : "");
}

function fillSettings(settings) {
  const calcParams = Calc.normalizeParams(settings.calculator_params);
  calcParamInputs.forEach((el) => {
    const v = calcParams[el.dataset.calcParam];
    el.value = v == null ? "" : String(v);
  });
  updateCalcParamsDerived();
  inputMultPrp.value = settings.mult_prp != null ? settings.mult_prp : "";
  inputMultMin.value = settings.mult_min != null ? settings.mult_min : "";
  inputMultMax.value = settings.mult_max != null ? settings.mult_max : "";
  snapshotSettings();
}

function readSettingsFromForm() {
  const out = {
    mult_prp: inputMultPrp.value,
    mult_min: inputMultMin.value,
    mult_max: inputMultMax.value,
  };
  calcParamInputs.forEach((el) => {
    out[`calc.${el.dataset.calcParam}`] = el.value;
  });
  return out;
}

/** Parametrii calculatorului asa cum sunt acum in formular (inclusiv nesalvati). */
function getCalcParams() {
  const raw = {};
  calcParamInputs.forEach((el) => {
    raw[el.dataset.calcParam] = el.value;
  });
  return Calc.normalizeParams(raw);
}

function settingsRequestBody() {
  return {
    mult_prp: inputMultPrp.value,
    mult_min: inputMultMin.value,
    mult_max: inputMultMax.value,
    calculator_params: getCalcParams(),
  };
}

function formatNum(n, digits = 2) {
  return n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits);
}

/** Valorile derivate din panou (RON/kg) + rezumatul din titlul panoului. */
function updateCalcParamsDerived() {
  const p = getCalcParams();
  if (calcAerRon) calcAerRon.value = formatNum(p.transport_aer_usd_kg * p.curs_usd);
  if (calcTrenRon) calcTrenRon.value = formatNum(p.transport_tren_usd_kg * p.curs_usd);
  if (calcParamsSummary) {
    const regim = Calc.REGIMURI.find((r) => r.value === p.regim)?.label || "";
    calcParamsSummary.textContent = `${regim} · $ ${p.curs_usd} · RMB ${p.curs_rmb} · preț cumpărare din ${
      p.transport_cumparare === "aer" ? "Aer" : "Tren/Mare"
    }`;
  }
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
      body: JSON.stringify(settingsRequestBody()),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Eroare HTTP ${res.status}`);
    fillSettings(data);
    updateDerivedCells();
    persistAllDerived();
    setStatus("Setări salvate.", "ok");
  } catch (err) {
    setStatus(err.message || "Eroare la salvare", "error");
  } finally {
    savingSettings = false;
    updateSaveDirtyState();
  }
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

const NAME_MAX_HEIGHT_PX = 160;

function autosizeNameTextarea(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, NAME_MAX_HEIGHT_PX)}px`;
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


/** PRP sub pretul de vanzare = configurare gresita; evidentiez celula. */
function syncPrpVsSale(tr, salePrice) {
  const prpCell = tr.querySelector("td[data-col='prp']");
  if (!prpCell) return;
  const prp = Number(prpCell.dataset.value);
  const sale = Number(salePrice);
  const low = Number.isFinite(prp) && Number.isFinite(sale) && prp < sale;
  prpCell.classList.toggle("is-prp-low", low);
}

/** Cate randuri au modificari locale nepublicate inca pe canal. */
function updateDirtyStatus() {
  const dirtyCount = tbody.querySelectorAll("tr.is-price-dirty").length;
  if (dirtyCount === 0) return;
  setStatus(
    `${dirtyCount} ${dirtyCount === 1 ? "produs" : "produse"} cu modificări nesalvate pe canal.`,
    "loading"
  );
}

function applyRowPrices(tr, salePrice, { markDirty = true } = {}) {
  const currency = tr.dataset.currency || "RON";
  const derived = derivePrices(salePrice);

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

  syncPrpVsSale(tr, salePrice);
  recalcRow(tr);
  updateDirtyStatus();
}

function updateDerivedCells() {
  tbody.querySelectorAll("tr[data-offer-id]").forEach((tr) => {
    const input = tr.querySelector("input.input-sale-price");
    if (!input) return;
    applyRowPrices(tr, input.value);
  });
  updateDirtyStatus();
}


function eanCell(product) {
  return product.ean ? escapeHtml(product.ean) : "—";
}

function pnkCell(product) {
  return product.part_number_key ? escapeHtml(product.part_number_key) : "—";
}

/** Seturi de poze: EN e cel implicit, folosit de platformele care nu au poze proprii. */
const IMAGE_PLATFORMS = [
  { key: "en", label: "EN" },
  { key: "ro", label: "RO" },
  { key: "bg", label: "BG" },
  { key: "hu", label: "HU" },
];
const IMAGE_FALLBACK_PLATFORM = "en";

/** Normalizeaza forma primita de la server: { en: [...], ro: [...], bg: [...], hu: [...] }. */
function imagesByPlatformOf(source) {
  const raw = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const out = {};
  for (const { key } of IMAGE_PLATFORMS) {
    out[key] = Array.isArray(raw[key]) ? raw[key] : [];
  }
  // Compat: raspuns vechi cu o singura lista de poze.
  if (Array.isArray(source)) out[IMAGE_FALLBACK_PLATFORM] = source;
  return out;
}

/** Pozele folosite efectiv de o platforma: ale ei daca are, altfel cele EN. */
function effectiveImagesOf(byPlatform, platform) {
  const own = byPlatform[platform] || [];
  if (platform === IMAGE_FALLBACK_PLATFORM || own.length) {
    return { images: own, inherited: false };
  }
  return { images: byPlatform[IMAGE_FALLBACK_PLATFORM] || [], inherited: true };
}

function imageThumbHtml(img, index, { inherited }) {
  const primaryClass = index === 0 ? " is-primary" : "";
  if (inherited) {
    // Pozele moștenite din EN nu se editează din tabul altei platforme.
    return `<span class="product-image-thumb is-inherited${primaryClass}">
        <img src="${escapeHtml(img.url)}" alt="" loading="lazy" title="Poză din setul EN" />
      </span>`;
  }
  const primaryBtn =
    index === 0
      ? `<button type="button" class="btn-set-primary is-active" data-image-id="${escapeHtml(img.id)}" aria-label="Poza principală" title="Poza principală" disabled>★</button>`
      : `<button type="button" class="btn-set-primary" data-image-id="${escapeHtml(img.id)}" aria-label="Setează ca poză principală" title="Setează ca poză principală">☆</button>`;
  return `<span class="product-image-thumb${primaryClass}" data-image-id="${escapeHtml(img.id)}">
      <img src="${escapeHtml(img.url)}" alt="" loading="lazy" title="Mărește" />
      ${primaryBtn}
      <button type="button" class="btn-delete-image" data-image-id="${escapeHtml(img.id)}" aria-label="Șterge poza">×</button>
    </span>`;
}

function imagesCellHtml(source, activePlatform = IMAGE_FALLBACK_PLATFORM) {
  const byPlatform = imagesByPlatformOf(source);
  const active = IMAGE_PLATFORMS.some((p) => p.key === activePlatform)
    ? activePlatform
    : IMAGE_FALLBACK_PLATFORM;
  const { images, inherited } = effectiveImagesOf(byPlatform, active);

  const tabs = IMAGE_PLATFORMS.map(({ key, label }) => {
    const own = (byPlatform[key] || []).length;
    const title =
      key === IMAGE_FALLBACK_PLATFORM
        ? "Poze în engleză — folosite oriunde nu ai poze proprii"
        : own
          ? `Poze proprii pentru eMAG ${label}`
          : `eMAG ${label} — momentan pe pozele EN`;
    return `<button type="button" class="btn-images-tab${key === active ? " is-active" : ""}${own ? "" : " is-empty"}" data-platform="${key}" title="${title}">${label}${own ? ` ${own}` : ""}</button>`;
  }).join("");

  const pushLabel = active === IMAGE_FALLBACK_PLATFORM ? "↑ eMAG toate" : `↑ eMAG ${active.toUpperCase()}`;
  const pushTarget = active === IMAGE_FALLBACK_PLATFORM ? "all" : active;
  const pushTitle =
    active === IMAGE_FALLBACK_PLATFORM
      ? "Trimite pozele pe eMAG RO, BG și HU"
      : `Trimite pozele pe eMAG ${active.toUpperCase()}`;

  return `<div class="product-images-cell">
    <div class="product-images-tabs">${tabs}</div>
    ${inherited ? '<p class="product-images-note">folosește pozele EN</p>' : ""}
    <div class="product-images-thumbs">${images
      .map((img, index) => imageThumbHtml(img, index, { inherited }))
      .join("")}</div>
    <div class="product-images-actions">
      <label class="product-images-add">
        <span>+ Poze</span>
        <input type="file" class="input-product-images" accept="image/jpeg,image/png,image/webp,image/gif" multiple />
      </label>
      <button type="button" class="btn-push-images" data-platform="${pushTarget}" title="${pushTitle}">${pushLabel}</button>
    </div>
  </div>`;
}

function updateImagesCell(tr, source, activePlatform) {
  const td = tr.querySelector('td[data-col="images"]');
  if (!td) return;
  const byPlatform = imagesByPlatformOf(source);
  const active = activePlatform || tr.dataset.imagesPlatform || IMAGE_FALLBACK_PLATFORM;
  tr.dataset.imagesPlatform = active;
  td.innerHTML = imagesCellHtml(byPlatform, active);
  td.dataset.count = String(effectiveImagesOf(byPlatform, active).images.length);
}

/** Pozele produsului din cache, pe platforme. */
function cachedImagesByPlatform(tr) {
  const cached = loadedProducts.find((p) => String(p.id) === String(tr.dataset.offerId));
  return imagesByPlatformOf(cached?.images_by_platform || cached?.images || {});
}

/** Scrie in cache setul primit de la server, pentru randarile urmatoare. */
function storeImagesInCache(tr, source) {
  const cached = loadedProducts.find((p) => String(p.id) === String(tr.dataset.offerId));
  if (!cached) return;
  const byPlatform = imagesByPlatformOf(source);
  cached.images_by_platform = byPlatform;
  cached.images = byPlatform[IMAGE_FALLBACK_PLATFORM];
}

function calcGreutateVolumetrica(latime, lungime, inaltime) {
  const w = Number(latime);
  const l = Number(lungime);
  const h = Number(inaltime);
  if (![w, l, h].every((n) => Number.isFinite(n) && n > 0)) return null;
  return (w * l * h) / 5000;
}

function formatGreutateVolumetrica(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

function dimHighlightClass(isLarger) {
  return isLarger ? "is-dim-blue" : "is-dim-gray";
}

function applyWeightHighlight(tr) {
  if (!tr) return;
  const greutateTd = tr.querySelector('td[data-col="greutate"]');
  const volTd = tr.querySelector('td[data-col="greutate_volumetrica"]');
  if (!greutateTd || !volTd) return;

  const dimVal = (field) => {
    const input = tr.querySelector(`input.input-dim[data-dim-field="${field}"]`);
    return numOrNull(input?.value);
  };

  const greutate = dimVal("greutate");
  const vol = calcGreutateVolumetrica(
    dimVal("latime"),
    dimVal("lungime"),
    dimVal("inaltime")
  );

  volTd.dataset.value = vol == null ? "" : String(vol);
  volTd.textContent = formatGreutateVolumetrica(vol);

  greutateTd.classList.remove("is-dim-blue", "is-dim-gray");
  volTd.classList.remove("is-dim-blue", "is-dim-gray");

  const greutateOk = greutate != null && Number.isFinite(greutate);
  const volOk = vol != null && Number.isFinite(vol);
  if (!greutateOk || !volOk) {
    if (greutateOk) greutateTd.classList.add("is-dim-gray");
    if (volOk) volTd.classList.add("is-dim-gray");
    return;
  }

  greutateTd.classList.add(dimHighlightClass(greutate > vol));
  volTd.classList.add(dimHighlightClass(vol > greutate));
}

function isEvening() {
  return new Date().getHours() >= 18;
}

/* ---------- Calculator (coloanele din Excel) ---------- */

/** [cheie din Calc.calcProduct, format]: lei | pct (fractie) | usd */
const CALC_COLS = [
  ["pret_achiz_china", "lei"],
  ["transport_aer", "lei"],
  ["transport_tren", "lei"],
  ["taxe_vamale_aer", "lei"],
  ["taxe_vamale_tren", "lei"],
  ["tva_import_aer", "lei"],
  ["tva_import_tren", "lei"],
  ["cost_final_aer", "lei"],
  ["cost_final_tren", "lei"],
  ["diferenta_aer_tren", "lei"],
  ["cat_salvezi", "pct"],
  ["pret_vanzare_fara_tva", "lei"],
  ["comision_valoare", "lei"],
  ["comision_tva", "lei"],
  ["impozit_aer", "lei"],
  ["impozit_tren", "lei"],
  ["tva_colectat_aer", "lei"],
  ["tva_colectat_tren", "lei"],
  ["profit_aer", "lei"],
  ["procent_profit_aer", "pct"],
  ["profit_tren", "lei"],
  ["procent_profit_tren", "pct"],
  ["break_even_aer", "lei"],
  ["break_even_tren", "lei"],
  ["cost_comanda_aer", "usd"],
  ["cost_comanda_tren", "usd"],
];
const CALC_KEYS = new Set(CALC_COLS.map(([key]) => key));
const PROFIT_KEYS = new Set([
  "profit_aer",
  "profit_tren",
  "procent_profit_aer",
  "procent_profit_tren",
]);

function formatCalcValue(value, kind) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (kind === "pct") return formatPercent(value * 100);
  if (kind === "usd") return `$ ${value.toFixed(2)}`;
  return formatPrice(value, "RON");
}

function readRowCalcInput(tr) {
  const val = (sel) => tr.querySelector(sel)?.value ?? "";
  const dim = (field) => val(`input.input-dim[data-dim-field="${field}"]`);
  const pct = val("input.input-procentaj-emag");
  return {
    pret_fabrica: val("input.input-pret-cumparare-usd"),
    moneda: val("select.input-moneda") || "USD",
    greutate: dim("greutate"),
    inaltime: dim("inaltime"),
    lungime: dim("lungime"),
    latime: dim("latime"),
    pret_vanzare: val("input.input-sale-price"),
    comision_emag: pct === "" ? DEFAULT_PROcentaj_EMAG : pct,
    nr_bucati: val("input.input-nr-bucati"),
  };
}

/** Recalculeaza toate coloanele calculatorului pe un rand (formulele din Excel). */
function recalcRow(tr, params = getCalcParams()) {
  const out = Calc.calcProduct(readRowCalcInput(tr), params);
  for (const [key, kind] of CALC_COLS) {
    const td = tr.querySelector(`td[data-col="${key}"]`);
    if (!td) continue;
    const v = out ? out[key] : null;
    const ok = v != null && Number.isFinite(v);
    td.dataset.value = ok ? String(kind === "pct" ? v * 100 : v) : "";
    td.textContent = formatCalcValue(v, kind);
    if (PROFIT_KEYS.has(key)) {
      td.classList.toggle("is-calc-negative", ok && v < 0);
      td.classList.toggle("is-calc-positive", ok && v >= 0);
    }
  }

  // Fara pret fabrica/greutate ramane pretul de cumparare salvat anterior (marcat).
  const buyTd = tr.querySelector('td[data-col="pret_cumparare"]');
  if (out) tr.dataset.pretCumparare = String(roundPrice(out.pret_cumparare));
  if (buyTd) {
    const buy = tr.dataset.pretCumparare ?? "";
    buyTd.dataset.value = buy;
    buyTd.innerHTML = formatPrice(buy === "" ? null : buy, tr.dataset.currency || "RON");
    buyTd.classList.toggle("is-cost-legacy", !out && buy !== "");
    buyTd.title = out
      ? "Cost final calculat (Parametri calculator)"
      : buy !== ""
        ? "Valoare veche: completează prețul de fabrică și greutatea ca să se calculeze"
        : "";
  }
}

function recalcAllRows() {
  const params = getCalcParams();
  tbody.querySelectorAll("tr[data-offer-id]").forEach((tr) => recalcRow(tr, params));
}

function rowHtml(product, index) {
  const currency = product.currency || "RON";
  const salePrice = product.sale_price ?? "";
  const pretCumparare = product.pret_cumparare ?? "";
  const pretCumparareUsd = product.pret_cumparare_usd ?? "";
  const hasNoOrdersInEvening =
    isEvening() && Number(product.order_count) === 0;
  const rowClasses = [
    Number(product.order_count) === 0 ? "is-no-orders" : "",
    hasNoOrdersInEvening ? "is-evening-no-orders" : "",
  ].filter(Boolean).join(" ");
  const linkCumparare = product.link_cumparare || "";
  const linkCumparareSafe = /^https?:\/\//i.test(linkCumparare) ? linkCumparare : "";
  const cellClass = (col, extra = "") => columns.cellClass(col, extra);
  const saleAttr = salePrice === "" || salePrice == null ? "" : Number(salePrice);
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
  const saleNum = Number(salePrice);
  const prpNum = Number(product.recommended_price);
  const prpLow =
    Number.isFinite(prpNum) &&
    Number.isFinite(saleNum) &&
    prpNum < saleNum;
  const prpExtra = prpLow ? "is-prp-low" : "";
  const stockArr = product.stock ?? [{ warehouse_id: 1, value: 0 }];
  const stockSum = stockSumFromArr(stockArr);
  const gs = Number(product.general_stock);
  const stockVal = Number.isFinite(gs) ? gs : stockSum;
  const stockJson = escapeHtml(JSON.stringify(stockArr));
  const handlingJson = escapeHtml(
    JSON.stringify(product.handling_time ?? [{ warehouse_id: 1, value: 0 }])
  );
  const imagesByPlatform = imagesByPlatformOf(product.images_by_platform || product.images);
  const imagesCount = (imagesByPlatform[IMAGE_FALLBACK_PLATFORM] || []).length;
  const productIdAttr =
    product.product_id != null && product.product_id !== ""
      ? ` data-product-id="${escapeHtml(product.product_id)}"`
      : "";
  const dimVal = (v) => (v == null || v === "" ? "" : Number(v));
  const greutate = dimVal(product.greutate);
  const inaltime = dimVal(product.inaltime);
  const lungime = dimVal(product.lungime);
  const latime = dimVal(product.latime);
  const greutateVol = calcGreutateVolumetrica(latime, lungime, inaltime);
  const greutateNum = greutate === "" ? null : Number(greutate);
  const greutateOk = greutateNum != null && Number.isFinite(greutateNum);
  const volOk = greutateVol != null && Number.isFinite(greutateVol);
  let greutateExtra = "col-dim";
  let volExtra = "";
  if (greutateOk && volOk) {
    greutateExtra += ` ${dimHighlightClass(greutateNum > greutateVol)}`;
    volExtra = dimHighlightClass(greutateVol > greutateNum);
  } else if (greutateOk) {
    greutateExtra += " is-dim-gray";
  } else if (volOk) {
    volExtra = "is-dim-gray";
  }
  const monedaFabrica = product.moneda_fabrica === "RMB" ? "RMB" : "USD";
  const procentajEmag =
    product.procentaj_emag != null && Number.isFinite(Number(product.procentaj_emag))
      ? Number(product.procentaj_emag)
      : DEFAULT_PROcentaj_EMAG;
  const pnk = String(product.part_number_key || "").trim();
  const linkEmag = pnk ? `https://www.emag.ro/-/pd/${encodeURIComponent(pnk)}/` : "";
  const linkInputCell = (field, value) => {
    const v = value || "";
    const safe = /^https?:\/\//i.test(v) ? v : "";
    return `<td data-col="${field}"${cellClass(field, "col-link-cumparare")}><div class="link-cumparare-wrap"><input type="url" class="input-link-extra" data-field="${field}" placeholder="https://…" value="${escapeHtml(v)}" /><a class="btn-open-link"${safe ? ` href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer"` : " hidden"} title="Deschide link" aria-label="Deschide link">↗</a></div></td>`;
  };
  const cells = {
    index: `<td data-col="index"${cellClass("index")}>${index}</td>`,
    id: `<td data-col="id"${cellClass("id")}>${escapeHtml(product.id)}</td>`,
    order_history: `<td data-col="order_history"${cellClass("order_history", "col-order-history")}><button type="button" class="btn-order-history" data-offer-id="${escapeHtml(product.id)}" data-product-name="${escapeHtml(product.name || product.part_number || `Produs ${product.id}`)}">Vezi istoricul</button></td>`,
    name: `<td data-col="name"${cellClass("name", "col-name")}><textarea class="input-name" rows="3">${escapeHtml(product.name || "")}</textarea></td>`,
    images: `<td data-col="images"${cellClass("images", "col-images")} data-count="${imagesCount}">${imagesCellHtml(imagesByPlatform)}</td>`,
    description: `<td data-col="description"${cellClass("description", "col-description")}><textarea class="input-description" rows="3">${escapeHtml(product.description || "")}</textarea></td>`,
    part_number: `<td data-col="part_number"${cellClass("part_number")}>${escapeHtml(product.part_number) || "—"}</td>`,
    id_familie: `<td data-col="id_familie"${cellClass("id_familie")}>${escapeHtml(product.id_familie) || "—"}</td>`,
    familie: `<td data-col="familie"${cellClass("familie")}>${escapeHtml(product.familie) || "—"}</td>`,
    pret_cumparare: `<td data-col="pret_cumparare"${cellClass("pret_cumparare", "col-calc")} data-value="${escapeHtml(pretCumparare)}">${formatPrice(pretCumparare, currency)}</td>`,
    pret_cumparare_usd: `<td data-col="pret_cumparare_usd"${cellClass("pret_cumparare_usd", "col-pret-cumparare-usd")}><input type="number" class="input-pret-cumparare-usd" min="0" step="0.01" value="${escapeHtml(pretCumparareUsd)}" /></td>`,
    link_cumparare: `<td data-col="link_cumparare"${cellClass("link_cumparare", "col-link-cumparare")}><div class="link-cumparare-wrap"><input type="url" class="input-link-cumparare" placeholder="https://…" value="${escapeHtml(linkCumparare)}" /><a class="btn-open-link"${linkCumparareSafe ? ` href="${escapeHtml(linkCumparareSafe)}" target="_blank" rel="noopener noreferrer"` : " hidden"} title="Deschide link" aria-label="Deschide link">↗</a></div></td>`,
    pret_emag: `<td data-col="pret_emag"${cellClass("pret_emag", "col-pret-emag")}><input type="number" class="input-sale-price" min="0" step="0.01" value="${escapeHtml(saleAttr)}" /></td>`,
    prp: `<td data-col="prp"${cellClass("prp", prpExtra)} data-value="${escapeHtml(product.recommended_price ?? "")}">${formatPrice(product.recommended_price, currency)}</td>`,
    pret_minim: `<td data-col="pret_minim"${cellClass("pret_minim", hasMinOverrideFlag ? "col-pret-minim is-min-override" : "col-pret-minim")} data-value="${escapeHtml(minInputVal)}"><div class="pret-minim-wrap"><input type="number" class="input-pret-minim" min="0" step="0.01" value="${escapeHtml(minInputVal)}" /><button type="button" class="btn-reset-min"${hasMinOverrideFlag ? "" : " hidden"} aria-label="Revine la multiplicator">×</button></div></td>`,
    pret_maxim: `<td data-col="pret_maxim"${cellClass("pret_maxim")} data-value="${escapeHtml(product.max_sale_price ?? "")}">${formatPrice(product.max_sale_price, currency)}</td>`,
    stoc: `<td data-col="stoc"${cellClass("stoc", "col-stoc")}><input type="number" class="input-stock" min="0" step="1" value="${escapeHtml(stockVal)}" /></td>`,
    greutate: `<td data-col="greutate"${cellClass("greutate", greutateExtra)}><input type="number" class="input-dim" data-dim-field="greutate" min="0" step="0.001" value="${escapeHtml(greutate)}" /></td>`,
    greutate_volumetrica: `<td data-col="greutate_volumetrica"${cellClass("greutate_volumetrica", volExtra)} data-value="${escapeHtml(greutateVol ?? "")}">${formatGreutateVolumetrica(greutateVol)}</td>`,
    inaltime: `<td data-col="inaltime"${cellClass("inaltime", "col-dim")}><input type="number" class="input-dim" data-dim-field="inaltime" min="0" step="0.01" value="${escapeHtml(inaltime)}" /></td>`,
    lungime: `<td data-col="lungime"${cellClass("lungime", "col-dim")}><input type="number" class="input-dim" data-dim-field="lungime" min="0" step="0.01" value="${escapeHtml(lungime)}" /></td>`,
    latime: `<td data-col="latime"${cellClass("latime", "col-dim")}><input type="number" class="input-dim" data-dim-field="latime" min="0" step="0.01" value="${escapeHtml(latime)}" /></td>`,
    ean: `<td data-col="ean"${cellClass("ean")}>${eanCell(product)}</td>`,
    pnk: `<td data-col="pnk"${cellClass("pnk")}>${pnkCell(product)}</td>`,
    moneda_fabrica: `<td data-col="moneda_fabrica"${cellClass("moneda_fabrica")}><select class="input-moneda"><option value="USD"${monedaFabrica === "USD" ? " selected" : ""}>$</option><option value="RMB"${monedaFabrica === "RMB" ? " selected" : ""}>RMB</option></select></td>`,
    procentaj_emag: `<td data-col="procentaj_emag"${cellClass("procentaj_emag", "col-procentaj-emag")}><input type="number" class="input-procentaj-emag" min="0" max="100" step="0.01" value="${escapeHtml(procentajEmag)}" /></td>`,
    nr_bucati: `<td data-col="nr_bucati"${cellClass("nr_bucati")}><input type="number" class="input-nr-bucati" min="0" step="1" value="${escapeHtml(product.nr_bucati ?? "")}" /></td>`,
    link_emag: `<td data-col="link_emag"${cellClass("link_emag")}>${linkEmag ? `<a href="${escapeHtml(linkEmag)}" target="_blank" rel="noopener noreferrer">eMAG ↗</a>` : "—"}</td>`,
    link_ali: linkInputCell("link_ali", product.link_ali),
    link_amz: linkInputCell("link_amz", product.link_amz),
    ce: `<td data-col="ce"${cellClass("ce")}><input type="text" class="input-text-field" data-field="ce" value="${escapeHtml(product.ce || "")}" /></td>`,
    decizie: `<td data-col="decizie"${cellClass("decizie")}><input type="text" class="input-text-field" data-field="decizie" value="${escapeHtml(product.decizie || "")}" /></td>`,
    ...Object.fromEntries(
      CALC_COLS.map(([key]) => [
        key,
        `<td data-col="${key}"${cellClass(key, "col-calc")} data-value="">—</td>`,
      ])
    ),
  };
  return `<tr data-offer-id="${escapeHtml(product.id)}"${productIdAttr}${rowClasses ? ` class="${rowClasses}"` : ""} data-original-sale="${escapeHtml(salePrice)}" data-original-stock="${escapeHtml(stockVal)}" data-original-name="${escapeHtml(product.name || "")}" data-original-description="" data-pret-cumparare="${escapeHtml(pretCumparare)}" data-currency="${escapeHtml(currency)}" data-original-prp="${escapeHtml(product.recommended_price ?? "")}" data-original-min="${escapeHtml(product.min_sale_price ?? "")}" data-original-max="${escapeHtml(product.max_sale_price ?? "")}" data-vat-id="${escapeHtml(product.vat_id ?? "")}" data-stock="${stockJson}" data-handling-time="${handlingJson}"${hasMinOverrideFlag ? ` data-min-override="${escapeHtml(minInputVal)}"` : ""}>
    ${columns.order.map((col) => cells[col] || "").join("")}
  </tr>`;
}


function getCellSortValue(tr, col) {
  const td = tr.querySelector(`td[data-col="${col}"]`);
  if (!td) return null;

  if (CALC_KEYS.has(col) || col === "pret_cumparare") {
    return parseSortNumber(td.dataset.value);
  }
  if (col === "procentaj_emag" || col === "nr_bucati") {
    return parseSortNumber(td.querySelector("input")?.value ?? "");
  }
  if (
    col === "moneda_fabrica" ||
    col === "link_ali" ||
    col === "link_amz" ||
    col === "ce" ||
    col === "decizie"
  ) {
    return String(td.querySelector("input, select")?.value ?? "").trim().toLowerCase() || null;
  }

  if (col === "pret_emag" || col === "pret_minim") {
    const input = td.querySelector("input");
    return parseSortNumber(input?.value);
  }
  if (col === "prp" || col === "pret_maxim" || col === "greutate_volumetrica") {
    return parseSortNumber(td.dataset.value);
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
  if (col === "pret_cumparare_usd") {
    return parseSortNumber(td.querySelector("input")?.value ?? "");
  }
  if (col === "link_cumparare") {
    return String(td.querySelector("input")?.value ?? "").trim().toLowerCase() || null;
  }
  if (
    col === "greutate" ||
    col === "inaltime" ||
    col === "lungime" ||
    col === "latime"
  ) {
    return parseSortNumber(td.querySelector("input")?.value ?? "");
  }
  if (col === "index" || col === "id") {
    return parseSortNumber(td.textContent);
  }
  if (col === "images") {
    return parseSortNumber(td.dataset.count ?? "0");
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

  if (CALC_KEYS.has(col) || col === "pret_cumparare") {
    const raw = td.dataset.value;
    return raw == null || raw === "" ? "" : String(roundPrice(Number(raw)));
  }
  if (col === "moneda_fabrica") {
    return td.querySelector("select")?.value === "RMB" ? "RMB" : "$";
  }
  if (
    col === "procentaj_emag" ||
    col === "nr_bucati" ||
    col === "link_ali" ||
    col === "link_amz" ||
    col === "ce" ||
    col === "decizie"
  ) {
    return String(td.querySelector("input")?.value ?? "").trim();
  }
  if (col === "link_emag") {
    return td.querySelector("a")?.href || "";
  }

  if (
    col === "pret_emag" ||
    col === "pret_minim" ||
    col === "pret_cumparare_usd" ||
    col === "link_cumparare" ||
    col === "stoc" ||
    col === "greutate" ||
    col === "inaltime" ||
    col === "lungime" ||
    col === "latime"
  ) {
    return String(td.querySelector("input")?.value ?? "").trim();
  }
  if (col === "greutate_volumetrica") {
    const raw = td.dataset.value;
    if (raw != null && raw !== "") return String(raw).trim();
    const text = (td.textContent || "").trim();
    return text === "—" ? "" : text;
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
  if (col === "images") {
    return String(td.dataset.count ?? "0");
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
      '<tr class="empty-row" data-filter-empty="1"><td colspan="23">Niciun rezultat pentru filtre.</td></tr>'
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



function renderProducts(products, append) {
  if (!append) {
    tbody.innerHTML = "";
  }

  if (!append && products.length === 0) {
    tbody.innerHTML =
      '<tr class="empty-row"><td colspan="23">Niciun produs găsit.</td></tr>';
    updateDirtyStatus();
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
  recalcAllRows();
  tbody
    .querySelectorAll("textarea.input-name")
    .forEach((el) => autosizeNameTextarea(el));
  tbody
    .querySelectorAll("textarea.input-description")
    .forEach((el) => autosizeDescriptionTextarea(el));
  if (sortCol) sortProductsTable();
  else applyColumnFilters();
  updateDirtyStatus();
}

async function loadProducts() {
  if (loading) return;
  loading = true;
  setStatus("Se încarcă din baza de date…", "loading");

  try {
    const res = await fetch("/api/catalog");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Eroare HTTP ${res.status}`);

    loadedProducts = Array.isArray(data.products) ? data.products : [];
    currentPage = 1;
    hasMore = false;
    btnMore.hidden = true;

    renderProducts(loadedProducts, false);
    if (loadedProducts.length === 0) {
      setStatus("Nimic în baza de date.", "error");
    } else {
      setStatus(`${loadedProducts.length} produse din baza de date`, "ok");
    }
  } catch (err) {
    setStatus(err.message || "Eroare la încărcare", "error");
    tbody.innerHTML = `<tr class="empty-row"><td colspan="23">${escapeHtml(
      err.message || "Eroare"
    )}</td></tr>`;
  } finally {
    loading = false;
    updateDirtyStatus();
  }
}





const ORDER_STATUS_LABELS = {
  0: "Anulat",
  1: "Nou",
  2: "În progres",
  3: "Preparat",
  4: "Finalizat",
  5: "Returnat",
};

function closeOrderHistory() {
  if (!orderHistoryModal) return;
  orderHistoryModal.hidden = true;
  orderHistoryBody.innerHTML = '<p class="muted">Selectează un produs pentru a vedea istoricul.</p>';
}

function formatOrderHistoryDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ro-RO");
}

function renderOrderHistory(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    orderHistoryBody.innerHTML = '<p class="muted">Nu există comenzi salvate pentru acest produs.</p>';
    return;
  }

  orderHistoryBody.innerHTML = `
    <div class="order-history-count">${orders.length} poziții de comandă</div>
    <div class="order-history-table-wrap">
      <table class="order-history-table">
        <thead>
          <tr>
            <th>Platformă</th>
            <th>Comandă</th>
            <th>Dată</th>
            <th>Status</th>
            <th>Client</th>
            <th>Cantitate</th>
            <th>Preț</th>
          </tr>
        </thead>
        <tbody>
          ${orders
            .map((order) => {
              const status = order.order_status ?? order.status;
              return `<tr>
                <td>${escapeHtml(order.channel || "emag")}</td>
                <td>${escapeHtml(order.order_id ?? "—")}</td>
                <td>${escapeHtml(formatOrderHistoryDate(order.order_date))}</td>
                <td>${escapeHtml(ORDER_STATUS_LABELS[Number(status)] || status || "—")}</td>
                <td>${escapeHtml(order.customer_name || "—")}</td>
                <td>${escapeHtml(order.quantity ?? "—")}</td>
                <td>${formatPrice(order.sale_price, order.currency || "RON")}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>`;
}

async function openOrderHistory(button) {
  const offerId = button?.dataset?.offerId;
  if (!offerId || !orderHistoryModal) return;

  orderHistoryProduct.textContent = button.dataset.productName || `Produs ${offerId}`;
  orderHistoryBody.innerHTML = '<p class="muted">Se încarcă istoricul…</p>';
  orderHistoryModal.hidden = false;

  try {
    const res = await fetch(`/api/products/${encodeURIComponent(offerId)}/history`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Eroare HTTP ${res.status}`);
    renderOrderHistory(data.orders);
  } catch (err) {
    orderHistoryBody.innerHTML = `<p class="status is-error">${escapeHtml(
      err.message || "Eroare la încărcarea istoricului"
    )}</p>`;
  }
}

tbody.addEventListener("click", (event) => {
  const button = event.target.closest(".btn-order-history");
  if (!button) return;
  event.stopPropagation();
  void openOrderHistory(button);
});

orderHistoryClose?.addEventListener("click", closeOrderHistory);
orderHistoryModal?.addEventListener("click", (event) => {
  if (event.target === orderHistoryModal) closeOrderHistory();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && orderHistoryModal && !orderHistoryModal.hidden) {
    closeOrderHistory();
  }
});

tbody.addEventListener("change", (e) => {
  const imagesInput = e.target.closest("input.input-product-images");
  if (imagesInput) void handleProductImagesSelected(imagesInput);
});

tbody.addEventListener("change", (e) => {
  const monedaSelect = e.target.closest("select.input-moneda");
  if (monedaSelect) {
    const tr = monedaSelect.closest("tr[data-offer-id]");
    if (!tr) return;
    recalcRow(tr);
    schedulePersistListing(
      tr.dataset.offerId,
      { moneda_fabrica: monedaSelect.value === "RMB" ? "RMB" : "USD" },
      "moneda-fabrica"
    );
    return;
  }

  const textInput = e.target.closest("input.input-text-field, input.input-link-extra");
  if (textInput) {
    const tr = textInput.closest("tr[data-offer-id]");
    const field = textInput.dataset.field;
    if (!tr || !field) return;
    const value = String(textInput.value || "").trim();
    textInput.value = value;
    schedulePersistListing(tr.dataset.offerId, { [field]: value || null }, field);
    return;
  }

  const usdInput = e.target.closest("input.input-pret-cumparare-usd");
  if (usdInput) {
    const tr = usdInput.closest("tr[data-offer-id]");
    if (!tr) return;
    schedulePersistListing(
      tr.dataset.offerId,
      { pret_cumparare_usd: numOrNull(usdInput.value) },
      "pret-cumparare-usd"
    );
    return;
  }

  const linkInput = e.target.closest("input.input-link-cumparare");
  if (!linkInput) return;
  const tr = linkInput.closest("tr[data-offer-id]");
  if (!tr) return;
  const value = String(linkInput.value || "").trim();
  linkInput.value = value;
  const openBtn = linkInput.closest("td")?.querySelector("a.btn-open-link");
  if (openBtn) {
    const safe = /^https?:\/\//i.test(value) ? value : "";
    if (safe) {
      openBtn.href = safe;
      openBtn.hidden = false;
    } else {
      openBtn.removeAttribute("href");
      openBtn.hidden = true;
    }
  }
  schedulePersistListing(
    tr.dataset.offerId,
    { link_cumparare: value || null },
    "link-cumparare"
  );
});

const imageLightbox = document.createElement("div");
imageLightbox.id = "image-lightbox";
imageLightbox.className = "image-lightbox";
imageLightbox.hidden = true;
imageLightbox.innerHTML = `
  <div class="image-lightbox-overlay" data-lightbox-close></div>
  <div class="image-lightbox-stage" role="dialog" aria-modal="true" aria-label="Imagine produs">
    <button type="button" class="image-lightbox-close" data-lightbox-close aria-label="Închide">×</button>
    <button type="button" class="image-lightbox-nav image-lightbox-prev" data-lightbox-prev aria-label="Anterior">‹</button>
    <img class="image-lightbox-img" alt="" />
    <button type="button" class="image-lightbox-nav image-lightbox-next" data-lightbox-next aria-label="Următor">›</button>
    <p class="image-lightbox-counter" hidden></p>
  </div>`;
document.body.appendChild(imageLightbox);

const lightboxImg = imageLightbox.querySelector(".image-lightbox-img");
const lightboxCounter = imageLightbox.querySelector(".image-lightbox-counter");
const lightboxPrev = imageLightbox.querySelector("[data-lightbox-prev]");
const lightboxNext = imageLightbox.querySelector("[data-lightbox-next]");

let lightboxUrls = [];
let lightboxIndex = 0;

function updateImageLightbox() {
  lightboxImg.src = lightboxUrls[lightboxIndex] || "";
  const multi = lightboxUrls.length > 1;
  lightboxPrev.hidden = !multi;
  lightboxNext.hidden = !multi;
  if (multi) {
    lightboxCounter.hidden = false;
    lightboxCounter.textContent = `${lightboxIndex + 1} / ${lightboxUrls.length}`;
  } else {
    lightboxCounter.hidden = true;
  }
}

function openImageLightbox(urls, index) {
  lightboxUrls = urls;
  lightboxIndex = index;
  updateImageLightbox();
  imageLightbox.hidden = false;
  document.body.classList.add("modal-open");
}

function closeImageLightbox() {
  if (imageLightbox.hidden) return;
  imageLightbox.hidden = true;
  document.body.classList.remove("modal-open");
  lightboxImg.removeAttribute("src");
  lightboxUrls = [];
  lightboxIndex = 0;
}

function stepImageLightbox(delta) {
  if (lightboxUrls.length < 2) return;
  lightboxIndex =
    (lightboxIndex + delta + lightboxUrls.length) % lightboxUrls.length;
  updateImageLightbox();
}

function openImageLightboxFromThumb(img) {
  const thumbsRoot = img.closest(".product-images-thumbs");
  if (!thumbsRoot) return;
  const imgs = [...thumbsRoot.querySelectorAll(".product-image-thumb img")];
  const index = imgs.indexOf(img);
  if (index < 0) return;
  openImageLightbox(
    imgs.map((el) => el.currentSrc || el.src),
    index
  );
}

imageLightbox.addEventListener("click", (e) => {
  if (e.target.closest("[data-lightbox-close]")) {
    closeImageLightbox();
    return;
  }
  if (e.target.closest("[data-lightbox-prev]")) {
    stepImageLightbox(-1);
    return;
  }
  if (e.target.closest("[data-lightbox-next]")) {
    stepImageLightbox(1);
  }
});

document.addEventListener("keydown", (e) => {
  if (imageLightbox.hidden) return;
  if (e.key === "Escape") {
    closeImageLightbox();
    e.stopImmediatePropagation();
    return;
  }
  if (e.key === "ArrowLeft") stepImageLightbox(-1);
  if (e.key === "ArrowRight") stepImageLightbox(1);
});

tbody.addEventListener("click", (e) => {
  const tabBtn = e.target.closest("button.btn-images-tab");
  if (tabBtn) {
    e.preventDefault();
    const tr = tabBtn.closest("tr[data-offer-id]");
    if (tr) updateImagesCell(tr, cachedImagesByPlatform(tr), tabBtn.dataset.platform);
    return;
  }
  const pushBtn = e.target.closest("button.btn-push-images");
  if (pushBtn) {
    e.preventDefault();
    void handleProductImagesPush(pushBtn);
    return;
  }
  const setPrimaryBtn = e.target.closest("button.btn-set-primary");
  if (setPrimaryBtn) {
    e.preventDefault();
    if (!setPrimaryBtn.disabled) void handleProductImageSetPrimary(setPrimaryBtn);
    return;
  }
  const btn = e.target.closest("button.btn-delete-image");
  if (btn) {
    e.preventDefault();
    void handleProductImageDelete(btn);
    return;
  }
  const thumbImg = e.target.closest(".product-image-thumb img");
  if (thumbImg) {
    e.preventDefault();
    openImageLightboxFromThumb(thumbImg);
  }
});

/** Trimite pozele produsului pe eMAG: platforma tabului activ, sau toate trei din tabul EN. */
async function handleProductImagesPush(btn) {
  const tr = btn.closest("tr[data-offer-id]");
  const productId = tr?.dataset.productId;
  const platform = btn.dataset.platform || "all";
  if (!tr || !productId) {
    setStatus("Produs fără product_id — nu pot trimite pozele.", "error");
    return;
  }
  const target = platform === "all" ? "eMAG RO, BG și HU" : `eMAG ${platform.toUpperCase()}`;
  if (!window.confirm(`Trimiți pozele pe ${target}?`)) return;

  btn.disabled = true;
  setStatus(`Se trimit pozele pe ${target}…`, "loading");
  try {
    const res = await fetch(
      `/api/catalog/product/${encodeURIComponent(productId)}/images/push?platform=${platform}`,
      { method: "POST" }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.results) throw new Error(data.error || `Eroare HTTP ${res.status}`);
    const parts = (data.results || []).map((r) =>
      r.ok
        ? `${r.platform.toUpperCase()}: ${r.count} poze${r.source && r.source !== r.platform ? ` (set ${r.source.toUpperCase()})` : ""}`
        : `${r.platform.toUpperCase()}: ${r.error}`
    );
    const allOk = (data.results || []).every((r) => r.ok);
    setStatus(
      `Poze trimise — eMAG procesează asincron. ${parts.join(" · ")}`,
      allOk ? "ok" : "error"
    );
  } catch (err) {
    setStatus(err.message || "Eroare la trimiterea pozelor", "error");
  } finally {
    btn.disabled = false;
  }
}

async function handleProductImagesSelected(input) {
  const tr = input.closest("tr[data-offer-id]");
  const productId = tr?.dataset.productId;
  const files = [...(input.files || [])];
  input.value = "";
  if (!tr || !productId) {
    setStatus("Produs fără product_id — nu pot salva poze.", "error");
    return;
  }
  if (!files.length) return;

  const platform = tr.dataset.imagesPlatform || IMAGE_FALLBACK_PLATFORM;
  const form = new FormData();
  for (const f of files) form.append("images", f);

  setStatus(`Se încarcă pozele (${platform.toUpperCase()})…`, "loading");
  try {
    const res = await fetch(
      `/api/catalog/product/${encodeURIComponent(productId)}/images?platform=${platform}`,
      { method: "POST", body: form }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Eroare HTTP ${res.status}`);
    updateImagesCell(tr, data.all, platform);
    storeImagesInCache(tr, data.all);
    setStatus(`Poze salvate (${platform.toUpperCase()}).`, "ok");
  } catch (err) {
    setStatus(err.message || "Eroare la upload poze", "error");
  }
}

async function handleProductImageDelete(btn) {
  const tr = btn.closest("tr[data-offer-id]");
  const productId = tr?.dataset.productId;
  const imageId = btn.dataset.imageId;
  if (!tr || !productId || !imageId) return;
  if (!window.confirm("Ștergi această poză?")) return;

  setStatus("Se șterge poza…", "loading");
  try {
    const res = await fetch(
      `/api/catalog/product/${encodeURIComponent(productId)}/images/${encodeURIComponent(imageId)}`,
      { method: "DELETE" }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Eroare HTTP ${res.status}`);
    updateImagesCell(tr, data.all);
    storeImagesInCache(tr, data.all);
    setStatus("Poză ștearsă.", "ok");
  } catch (err) {
    setStatus(err.message || "Eroare la ștergere poză", "error");
  }
}

async function handleProductImageSetPrimary(btn) {
  const tr = btn.closest("tr[data-offer-id]");
  const productId = tr?.dataset.productId;
  const imageId = Number(btn.dataset.imageId);
  if (!tr || !productId || !Number.isFinite(imageId) || imageId <= 0) return;

  const platform = tr.dataset.imagesPlatform || IMAGE_FALLBACK_PLATFORM;
  const thumbs = [
    ...tr.querySelectorAll(".product-image-thumb:not(.is-inherited)[data-image-id]"),
  ];
  const ids = thumbs
    .map((el) => Number(el.dataset.imageId))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length || ids[0] === imageId) return;

  const imageIds = [imageId, ...ids.filter((id) => id !== imageId)];

  setStatus("Se setează poza principală…", "loading");
  try {
    const res = await fetch(
      `/api/catalog/product/${encodeURIComponent(productId)}/images/order?platform=${platform}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_ids: imageIds }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Eroare HTTP ${res.status}`);
    updateImagesCell(tr, data.all, platform);
    storeImagesInCache(tr, data.all);
    setStatus("Poza principală actualizată.", "ok");
  } catch (err) {
    setStatus(err.message || "Eroare la setarea pozei principale", "error");
  }
}

tbody.addEventListener("focusin", (e) => {
  const nameInput = e.target.closest("textarea.input-name");
  if (nameInput) {
    autosizeNameTextarea(nameInput);
    return;
  }
  const descriptionInput = e.target.closest("textarea.input-description");
  if (descriptionInput) autosizeDescriptionTextarea(descriptionInput);
});

tbody.addEventListener("focusout", (e) => {
  const nameInput = e.target.closest("textarea.input-name");
  if (nameInput) {
    const tr = nameInput.closest("tr[data-offer-id]");
    if (!tr) return;
    schedulePersistName(tr.dataset.offerId, nameInput.value, { immediate: true });
    return;
  }
  const descriptionInput = e.target.closest("textarea.input-description");
  if (descriptionInput) {
    const tr = descriptionInput.closest("tr[data-offer-id]");
    if (!tr) return;
    schedulePersistDescription(tr.dataset.offerId, descriptionInput.value, {
      immediate: true,
    });
  }
});

tbody.addEventListener("input", (e) => {
  const usdInput = e.target.closest("input.input-pret-cumparare-usd");
  if (usdInput) {
    const tr = usdInput.closest("tr[data-offer-id]");
    if (tr) recalcRow(tr);
    return;
  }

  const nrBucatiInput = e.target.closest("input.input-nr-bucati");
  if (nrBucatiInput) {
    const tr = nrBucatiInput.closest("tr[data-offer-id]");
    if (!tr) return;
    recalcRow(tr);
    schedulePersistListing(
      tr.dataset.offerId,
      { nr_bucati: numOrNull(nrBucatiInput.value) },
      "nr-bucati"
    );
    return;
  }

  const procentajInput = e.target.closest("input.input-procentaj-emag");
  if (procentajInput) {
    const tr = procentajInput.closest("tr[data-offer-id]");
    if (!tr) return;
    recalcRow(tr);
    schedulePersistListing(
      tr.dataset.offerId,
      { procentaj_emag: numOrNull(procentajInput.value) },
      "procentaj-emag"
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
    schedulePersistPretMinim(
      tr.dataset.offerId,
      minInput.value === "" ? 0 : minInput.value
    );
    return;
  }

  const stockInput = e.target.closest("input.input-stock");
  if (stockInput) {
    const tr = stockInput.closest("tr[data-offer-id]");
    if (!tr) return;
    setRowStock(tr, stockInput.value === "" ? 0 : stockInput.value);
    const saleInput = tr.querySelector("input.input-sale-price");
    applyRowPrices(tr, saleInput?.value ?? "");
    schedulePersistStock(tr.dataset.offerId, parseJsonAttr(tr.dataset.stock, []));
    return;
  }

  const dimInput = e.target.closest("input.input-dim");
  if (dimInput) {
    const tr = dimInput.closest("tr[data-offer-id]");
    const field = dimInput.dataset.dimField;
    if (!tr || !field) return;
    applyWeightHighlight(tr);
    recalcRow(tr);
    schedulePersistListing(
      tr.dataset.offerId,
      { [field]: numOrNull(dimInput.value) },
      field
    );
    return;
  }

  const linkInput = e.target.closest("input.input-link-cumparare, input.input-link-extra");
  if (linkInput) {
    const tr = linkInput.closest("tr[data-offer-id]");
    if (!tr) return;
    const openBtn = linkInput.closest("td")?.querySelector("a.btn-open-link");
    if (!openBtn) return;
    const value = String(linkInput.value || "").trim();
    const safe = /^https?:\/\//i.test(value) ? value : "";
    if (safe) {
      openBtn.href = safe;
      openBtn.hidden = false;
    } else {
      openBtn.removeAttribute("href");
      openBtn.hidden = true;
    }
    return;
  }

  const nameInput = e.target.closest("textarea.input-name");
  if (nameInput) {
    const tr = nameInput.closest("tr[data-offer-id]");
    if (!tr) return;
    autosizeNameTextarea(nameInput);
    const saleInput = tr.querySelector("input.input-sale-price");
    applyRowPrices(tr, saleInput?.value ?? "");
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
    schedulePersistDescription(tr.dataset.offerId, descriptionInput.value);
    return;
  }

  const input = e.target.closest("input.input-sale-price");
  if (!input) return;
  const tr = input.closest("tr[data-offer-id]");
  if (!tr) return;
  applyRowPrices(tr, input.value);
  schedulePersistSalePrice(tr.dataset.offerId, input.value);
  schedulePersistDerived(tr);
});

tbody.addEventListener("click", (e) => {
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
  schedulePersistPretMinim(tr.dataset.offerId, null);
  schedulePersistDerived(tr);
});

/* ---------- Persistare in DB (sursa de adevar) ---------- */

const schedulePersistListing = createPersister({
  getChannel: () => LISTING_CHANNEL,
  onSaved: (id, fields) => patchLoadedProduct(id, fields),
  onError: (err) => setStatus(err.message || "Eroare la salvare", "error"),
});

function patchLoadedProduct(id, fields) {
  const idx = loadedProducts.findIndex((p) => String(p.id) === String(id));
  if (idx === -1) return;
  loadedProducts[idx] = { ...loadedProducts[idx], ...fields };
}



function schedulePersistPretMinim(offerId, value) {
  schedulePersistListing(
    offerId,
    { pret_minim_override: numOrNull(value) },
    "pret-minim"
  );
}


function schedulePersistSalePrice(offerId, value) {
  schedulePersistListing(offerId, { sale_price: numOrNull(value) }, "pret");
}

function schedulePersistStock(offerId, stockArr) {
  schedulePersistListing(offerId, { stock: stockArr }, "stoc");
}

function schedulePersistName(offerId, value, opts) {
  schedulePersistListing(offerId, { name: String(value ?? "") }, "nume", opts);
}

function schedulePersistDescription(offerId, value, opts) {
  schedulePersistListing(
    offerId,
    { description: String(value ?? "") },
    "descriere",
    opts
  );
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

function persistAllDerived() {
  tbody.querySelectorAll("tr[data-offer-id]").forEach((tr) => {
    schedulePersistDerived(tr);
  });
}

/* ---------- Export Excel ---------- */

const EXPORT_NUMERIC_COLS = new Set([
  "index",
  "id",
  "id_familie",
  "pret_cumparare",
  "pret_cumparare_usd",
  "pret_emag",
  "procentaj_emag",
  "nr_bucati",
  ...CALC_KEYS,
  "prp",
  "pret_minim",
  "pret_maxim",
  "stoc",
  "greutate",
  "greutate_volumetrica",
  "inaltime",
  "lungime",
  "latime",
]);

function toExportValue(col, text) {
  const raw = String(text ?? "").trim();
  if (!raw || raw === "—") return null;
  if (!EXPORT_NUMERIC_COLS.has(col)) return raw;

  // UI folosește "." ca zecimal (input[type=number] / Number). Nu șterge
  // punctele „de mii” orbește — altfel 0.775 → 775 și 3.344 → 3344.
  let cleaned = raw.replace(/[^\d,.\-]/g, "");
  if (cleaned.includes(",") && cleaned.includes(".")) {
    // format EU: 1.234,56
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (cleaned.includes(",")) {
    cleaned = cleaned.replace(",", ".");
  }
  const num = Number(cleaned);
  return Number.isFinite(num) && cleaned !== "" ? num : raw;
}

function collectExportRows(mode) {
  const cols =
    mode === "all"
      ? [...columns.order]
      : columns.order.filter((c) => !columns.isHidden(c));
  const allRows = [...tbody.querySelectorAll("tr[data-offer-id]")];
  const rows = mode === "all" ? allRows : allRows.filter((tr) => !tr.classList.contains("is-row-filtered"));

  return {
    cols,
    headers: cols.map((col) => columns.labels[col] || col),
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
      `produse-${stamp}.xlsx`
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
btnMore.hidden = true;

table.querySelector("thead")?.addEventListener("click", (e) => {
  if (e.target.closest(".filter-row") || e.target.closest(".col-filter")) return;
  if (e.target.closest(".col-resize-handle")) return;
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

function onCalcParamInput() {
  updateCalcParamsDerived();
  recalcAllRows();
  updateSaveDirtyState();
}

function onMultInput() {
  updateDerivedCells();
  persistAllDerived();
  updateSaveDirtyState();
}

calcParamInputs.forEach((el) => el.addEventListener("input", onCalcParamInput));
if (calcRegimSelect) {
  calcRegimSelect.innerHTML = Calc.REGIMURI.map(
    (r) => `<option value="${escapeHtml(r.value)}">${escapeHtml(r.label)}</option>`
  ).join("");
}
inputMultPrp.addEventListener("input", onMultInput);
inputMultMin.addEventListener("input", onMultInput);
inputMultMax.addEventListener("input", onMultInput);

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

function setCompactProducts(on) {
  if (!productsWrap || !btnCompactProducts) return;
  productsWrap.classList.toggle("is-compact", on);
  btnCompactProducts.setAttribute("aria-pressed", on ? "true" : "false");
  btnCompactProducts.textContent = on ? "Normal" : "Compact";
  try {
    localStorage.setItem(COMPACT_PRODUCTS_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

btnCompactProducts?.addEventListener("click", () => {
  setCompactProducts(!productsWrap.classList.contains("is-compact"));
});

try {
  setCompactProducts(localStorage.getItem(COMPACT_PRODUCTS_KEY) === "1");
} catch {
  setCompactProducts(false);
}

/** Publica toate modificarile pe toate canalele configurate (backend-ul preia oglinda daca lipseste). */
async function pushAllChannels() {
  if (!confirm("Trimit toate modificările pe toate canalele configurate?")) return;
  btnPushAll.disabled = true;
  setStatus("Se publică pe canale…", "loading");
  try {
    const res = await fetch("/api/sync/push-all", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Eroare ${res.status}`);
    const results = data.results || [];
    if (results.length === 0) {
      setStatus("Niciun canal configurat", "error");
      return;
    }
    const summary = results
      .map((r) => {
        if (!r.ok) return `${r.label}: eroare — ${r.error}`;
        return `${r.label}: ${r.count > 0 ? `${r.count} trimise` : "nimic de trimis"}`;
      })
      .join(" · ");
    setStatus(summary, data.ok ? "ok" : "error");
  } catch (err) {
    setStatus(err.message || "Eroare la publicare pe canale", "error");
  } finally {
    btnPushAll.disabled = false;
  }
}

btnPushAll?.addEventListener("click", pushAllChannels);

document.addEventListener("click", () => {
  if (exportMenu && !exportMenu.hidden) setExportMenuOpen(false);
});

columns.applyOrder();
columns.buildMenu();
columns.applyVisibility();
updateDirtyStatus();
loadSettings().then(() => loadProducts());

