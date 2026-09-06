/* Calculele si formatarile comune stau in pricing.js (incarcat inaintea acestui fisier). */
const {
  DEFAULT_ALTE_COSTURI,
  escapeHtml,
  formatPrice,
  relativeTimeRo,
  stalenessClass,
  numOrNull,
  parseJsonAttr,
  parseSortNumber,
  parseAlteCosturi,
  roundPrice,
  pricesEqual,
  stockSumFromArr,
  alteFromProcentaj,
  createPersister,
} = window.Pricing;

const btnMore = document.getElementById("btn-more");
const btnSaveSettings = document.getElementById("btn-save-settings");
const btnColumns = document.getElementById("btn-columns");
const btnExport = document.getElementById("btn-export");
const btnExportMenu = document.getElementById("btn-export-menu");
const exportMenu = document.getElementById("export-menu");
const btnTableFullscreen = document.getElementById("btn-table-fullscreen");
const btnCompactProducts = document.getElementById("btn-compact-products");
const colMenu = document.getElementById("col-menu");
const statusEl = document.getElementById("status");
const tbody = document.getElementById("products-body");
const table = document.getElementById("products-table");
const productsWrap = document.getElementById("products-wrap");
const pageEl = document.querySelector(".page");
const inputProcentajAlte = document.getElementById("procentaj-alte-costuri");
const inputMultPrp = document.getElementById("mult-prp");
const inputMultMin = document.getElementById("mult-min");
const inputMultMax = document.getElementById("mult-max");
const inputTotalAlteStoc = document.getElementById("total-alte-stoc");

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

function migrateLegacyCostCols(cols) {
  const OLD = new Set(["procentaj_alte_costuri"]);
  const RENAMED = new Set(["pret_transport", "alte_costuri"]);
  const out = [];
  let insertedAlte = false;
  for (const c of cols) {
    if (RENAMED.has(c)) {
      if (!insertedAlte && !out.includes("transport_override")) {
        out.push("transport_override");
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

const columns = window.TableColumns.create({
  table,
  tbody,
  menuEl: colMenu,
  buttonEl: btnColumns,
  hiddenKey: HIDDEN_COLS_KEY,
  orderKey: COL_ORDER_KEY,
  migrate: migrateLegacyCostCols,
});

function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (type ? ` is-${type}` : "");
}

function fillSettings(settings) {
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
  const alteCell = tr.querySelector("td[data-col='transport_override']");
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

function updateToolbarTotals() {
  updateTotalAlteStoc();
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
  const alteCosturi = getRowAlteCosturi(tr);
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
  syncAlteCosturiCell(tr, alteCosturi);
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
  updateDirtyStatus();
}

function updateDerivedCells() {
  tbody.querySelectorAll("tr[data-offer-id]").forEach((tr) => {
    const input = tr.querySelector("input.input-sale-price");
    if (!input) return;
    applyRowPrices(tr, input.value);
  });
  updateToolbarTotals();
  updateDirtyStatus();
}


function eanCell(product) {
  return product.ean ? escapeHtml(product.ean) : "—";
}

function pnkCell(product) {
  return product.part_number_key ? escapeHtml(product.part_number_key) : "—";
}

function imagesCellHtml(images) {
  const list = Array.isArray(images) ? images : [];
  const thumbs = list
    .map(
      (img) =>
        `<span class="product-image-thumb" data-image-id="${escapeHtml(img.id)}">
          <img src="${escapeHtml(img.url)}" alt="" loading="lazy" title="Mărește" />
          <button type="button" class="btn-delete-image" data-image-id="${escapeHtml(img.id)}" aria-label="Șterge poza">×</button>
        </span>`
    )
    .join("");
  return `<div class="product-images-cell">
    <div class="product-images-thumbs">${thumbs}</div>
    <label class="product-images-add">
      <span>+ Poze</span>
      <input type="file" class="input-product-images" accept="image/jpeg,image/png,image/webp,image/gif" multiple />
    </label>
  </div>`;
}

function updateImagesCell(tr, images) {
  const td = tr.querySelector('td[data-col="images"]');
  if (!td) return;
  td.innerHTML = imagesCellHtml(images);
  td.dataset.count = String(Array.isArray(images) ? images.length : 0);
}

function rowHtml(product, index) {
  const currency = product.currency || "RON";
  const salePrice = product.sale_price ?? "";
  const pretCumparare = product.pret_cumparare ?? "";
  const cellClass = (col, extra = "") => columns.cellClass(col, extra);
  const saleAttr = salePrice === "" || salePrice == null ? "" : Number(salePrice);
  const hasOverride =
    product.transport_override != null && Number.isFinite(Number(product.transport_override));
  const alte = hasOverride
    ? Number(product.transport_override)
    : alteFromProcentaj(getGlobalProcentajAlte() ?? "", pretCumparare);
  const alteInputVal =
    alte == null || !Number.isFinite(Number(alte)) ? "" : Number(alte);
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
  const images = Array.isArray(product.images) ? product.images : [];
  const productIdAttr =
    product.product_id != null && product.product_id !== ""
      ? ` data-product-id="${escapeHtml(product.product_id)}"`
      : "";
  const cells = {
    index: `<td data-col="index"${cellClass("index")}>${index}</td>`,
    id: `<td data-col="id"${cellClass("id")}>${escapeHtml(product.id)}</td>`,
    name: `<td data-col="name"${cellClass("name", "col-name")}><textarea class="input-name" rows="3">${escapeHtml(product.name || "")}</textarea></td>`,
    images: `<td data-col="images"${cellClass("images", "col-images")} data-count="${images.length}">${imagesCellHtml(images)}</td>`,
    description: `<td data-col="description"${cellClass("description", "col-description")}><textarea class="input-description" rows="3">${escapeHtml(product.description || "")}</textarea></td>`,
    part_number: `<td data-col="part_number"${cellClass("part_number")}>${escapeHtml(product.part_number) || "—"}</td>`,
    id_familie: `<td data-col="id_familie"${cellClass("id_familie")}>${escapeHtml(product.id_familie) || "—"}</td>`,
    familie: `<td data-col="familie"${cellClass("familie")}>${escapeHtml(product.familie) || "—"}</td>`,
    pret_cumparare: `<td data-col="pret_cumparare"${cellClass("pret_cumparare", "col-pret-cumparare")}><input type="number" class="input-pret-cumparare" min="0" step="0.01" value="${escapeHtml(pretCumparare)}" /></td>`,
    transport_override: `<td data-col="transport_override"${cellClass("transport_override", hasOverride ? "col-alte-costuri is-alte-override" : "col-alte-costuri")}><div class="alte-costuri-wrap"><input type="number" class="input-alte-costuri" min="0" step="0.01" value="${escapeHtml(alteInputVal)}" /><button type="button" class="btn-reset-alte"${hasOverride ? "" : " hidden"} aria-label="Revine la procentaj">×</button></div></td>`,
    pret_emag: `<td data-col="pret_emag"${cellClass("pret_emag", "col-pret-emag")}><input type="number" class="input-sale-price" min="0" step="0.01" value="${escapeHtml(saleAttr)}" /></td>`,
    prp: `<td data-col="prp"${cellClass("prp", prpExtra)} data-value="${escapeHtml(product.recommended_price ?? "")}">${formatPrice(product.recommended_price, currency)}</td>`,
    pret_minim: `<td data-col="pret_minim"${cellClass("pret_minim", hasMinOverrideFlag ? "col-pret-minim is-min-override" : "col-pret-minim")} data-value="${escapeHtml(minInputVal)}"><div class="pret-minim-wrap"><input type="number" class="input-pret-minim" min="0" step="0.01" value="${escapeHtml(minInputVal)}" /><button type="button" class="btn-reset-min"${hasMinOverrideFlag ? "" : " hidden"} aria-label="Revine la multiplicator">×</button></div></td>`,
    pret_maxim: `<td data-col="pret_maxim"${cellClass("pret_maxim")} data-value="${escapeHtml(product.max_sale_price ?? "")}">${formatPrice(product.max_sale_price, currency)}</td>`,
    stoc: `<td data-col="stoc"${cellClass("stoc", "col-stoc")}><input type="number" class="input-stock" min="0" step="1" value="${escapeHtml(stockVal)}" /></td>`,
    ean: `<td data-col="ean"${cellClass("ean")}>${eanCell(product)}</td>`,
    pnk: `<td data-col="pnk"${cellClass("pnk")}>${pnkCell(product)}</td>`,
  };
  return `<tr data-offer-id="${escapeHtml(product.id)}"${productIdAttr} data-original-sale="${escapeHtml(salePrice)}" data-original-stock="${escapeHtml(stockVal)}" data-original-name="${escapeHtml(product.name || "")}" data-original-description="" data-pret-cumparare="${escapeHtml(pretCumparare)}" data-currency="${escapeHtml(currency)}" data-original-prp="${escapeHtml(product.recommended_price ?? "")}" data-original-min="${escapeHtml(product.min_sale_price ?? "")}" data-original-max="${escapeHtml(product.max_sale_price ?? "")}" data-vat-id="${escapeHtml(product.vat_id ?? "")}" data-stock="${stockJson}" data-handling-time="${handlingJson}"${hasOverride ? ` data-alte-override="${escapeHtml(alteInputVal)}"` : ""}${hasMinOverrideFlag ? ` data-min-override="${escapeHtml(minInputVal)}"` : ""}>
    ${columns.order.map((col) => cells[col] || "").join("")}
  </tr>`;
}


function getCellSortValue(tr, col) {
  const td = tr.querySelector(`td[data-col="${col}"]`);
  if (!td) return null;

  if (col === "pret_emag" || col === "transport_override" || col === "pret_minim") {
    const input = td.querySelector("input");
    return parseSortNumber(input?.value);
  }
  if (col === "prp" || col === "pret_maxim") {
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
  if (col === "pret_cumparare") {
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

  if (
    col === "pret_emag" ||
    col === "transport_override" ||
    col === "pret_minim" ||
    col === "pret_cumparare" ||
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
      '<tr class="empty-row" data-filter-empty="1"><td colspan="17">Niciun rezultat pentru filtre.</td></tr>'
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

function applyCostOverrideToProduct(product, override) {
  if (!override) return product;
  const next = { ...product };
  if ("transport_override" in override) {
    next.transport_override =
      override.transport_override == null || !Number.isFinite(Number(override.transport_override))
        ? null
        : Number(override.transport_override);
  }
  return next;
}


function renderProducts(products, append) {
  if (!append) {
    tbody.innerHTML = "";
  }

  if (!append && products.length === 0) {
    tbody.innerHTML =
      '<tr class="empty-row"><td colspan="17">Niciun produs găsit.</td></tr>';
    updateDirtyStatus();
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
  updateDirtyStatus();
  updateToolbarTotals();
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
    tbody.innerHTML = `<tr class="empty-row"><td colspan="17">${escapeHtml(
      err.message || "Eroare"
    )}</td></tr>`;
  } finally {
    loading = false;
    updateDirtyStatus();
  }
}





/** Pretul de cumparare se editeaza doar dupa confirmare explicita. */
tbody.addEventListener("change", (e) => {
  const imagesInput = e.target.closest("input.input-product-images");
  if (imagesInput) {
    void handleProductImagesSelected(imagesInput);
    return;
  }

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
  const saleInput = tr.querySelector("input.input-sale-price");
  applyRowPrices(tr, saleInput?.value ?? "");
  updateToolbarTotals();
  schedulePersistPretCumparare(tr.dataset.offerId, next);
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

  const form = new FormData();
  for (const f of files) form.append("images", f);

  setStatus("Se încarcă pozele…", "loading");
  try {
    const res = await fetch(`/api/catalog/product/${encodeURIComponent(productId)}/images`, {
      method: "POST",
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Eroare HTTP ${res.status}`);
    updateImagesCell(tr, data.all || data.images || []);
    const offerId = tr.dataset.offerId;
    const cached = loadedProducts.find(
      (p) => String(p.id) === String(offerId)
    );
    if (cached) cached.images = data.all || data.images || [];
    setStatus("Poze salvate.", "ok");
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
    updateImagesCell(tr, data.all || []);
    const offerId = tr.dataset.offerId;
    const cached = loadedProducts.find(
      (p) => String(p.id) === String(offerId)
    );
    if (cached) cached.images = data.all || [];
    setStatus("Poză ștearsă.", "ok");
  } catch (err) {
    setStatus(err.message || "Eroare la ștergere poză", "error");
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

function schedulePersistAlteCosturi(offerId, value) {
  schedulePersistListing(offerId, { transport_override: numOrNull(value) }, "alte-costuri");
}

function schedulePersistPretCumparare(offerId, value) {
  schedulePersistListing(offerId, { pret_cumparare: numOrNull(value) }, "pret-cumparare");
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
  "transport_override",
  "pret_emag",
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

function onMultInput() {
  updateDerivedCells();
  persistAllDerived();
  updateSaveDirtyState();
}

inputProcentajAlte.addEventListener("input", onSettingsInput);
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

document.addEventListener("click", () => {
  if (exportMenu && !exportMenu.hidden) setExportMenuOpen(false);
});

columns.applyOrder();
columns.buildMenu();
columns.applyVisibility();
updateDirtyStatus();
loadSettings().then(() => loadProducts());

