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
const inputTransport = document.getElementById("pret-transport");
const inputContabil = document.getElementById("pret-contabil");
const inputProcentaj = document.getElementById("procentaj-emag");
const inputNumarProduse = document.getElementById("numar-produse");
const inputMultPrp = document.getElementById("mult-prp");
const inputMultMin = document.getElementById("mult-min");
const inputMultMax = document.getElementById("mult-max");

const HIDDEN_COLS_KEY = "emag-hidden-columns";

let currentPage = 1;
let loading = false;
let savingSettings = false;
let syncing = false;
let hiddenCols = loadHiddenCols();
let savedSettingsSnapshot = null;

function loadHiddenCols() {
  try {
    const raw = localStorage.getItem(HIDDEN_COLS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function saveHiddenCols() {
  localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify(hiddenCols));
}

function applyColumnVisibility() {
  const hidden = new Set(hiddenCols);
  table.querySelectorAll("[data-col]").forEach((el) => {
    el.classList.toggle("is-col-hidden", hidden.has(el.dataset.col));
  });
}

function buildColumnMenu() {
  const headers = [...table.querySelectorAll("thead th[data-col]")];
  colMenu.innerHTML = headers
    .map((th) => {
      const col = th.dataset.col;
      const checked = !hiddenCols.includes(col) ? "checked" : "";
      return `<label><input type="checkbox" data-col-toggle="${escapeHtml(col)}" ${checked} />${escapeHtml(th.textContent.trim())}</label>`;
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
  inputTransport.value =
    settings.pret_transport != null ? settings.pret_transport : "";
  inputContabil.value =
    settings.pret_contabil != null ? settings.pret_contabil : "";
  inputProcentaj.value =
    settings.procentaj_emag != null ? settings.procentaj_emag : "";
  inputNumarProduse.value =
    settings.numar_produse != null ? settings.numar_produse : "";
  inputMultPrp.value = settings.mult_prp != null ? settings.mult_prp : "";
  inputMultMin.value = settings.mult_min != null ? settings.mult_min : "";
  inputMultMax.value = settings.mult_max != null ? settings.mult_max : "";
  snapshotSettings();
}

function readSettingsFromForm() {
  return {
    pret_transport: inputTransport.value,
    pret_contabil: inputContabil.value,
    procentaj_emag: inputProcentaj.value,
    numar_produse: inputNumarProduse.value,
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

function costPerUnit(inputEl) {
  const value = Number(inputEl.value);
  const count = Number(inputNumarProduse.value);
  if (
    inputEl.value === "" ||
    inputNumarProduse.value === "" ||
    Number.isNaN(value) ||
    Number.isNaN(count) ||
    count <= 0
  ) {
    return null;
  }
  return value / count;
}

function calcProfit(salePrice, pretCumparare) {
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
  const transport = costPerUnit(inputTransport) ?? 0;
  const contabil = costPerUnit(inputContabil) ?? 0;

  return afterEmag - buyCost - transport - contabil;
}

function calcProcentajProfit(salePrice, pretCumparare) {
  const profit = calcProfit(salePrice, pretCumparare);
  const minProfit = calcPretMinimProfit(pretCumparare);
  if (profit == null || minProfit == null) return null;
  if (!Number.isFinite(profit) || !Number.isFinite(minProfit) || minProfit === 0) {
    return null;
  }
  return (profit / minProfit) * 100;
}

function saleFromProcentaj(procentaj, pretCumparare) {
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

  const minProfit = calcPretMinimProfit(pretCumparare);
  if (minProfit == null || !Number.isFinite(minProfit)) return null;

  const buy = Number(pretCumparare);
  const buyCost =
    pretCumparare == null || pretCumparare === "" || Number.isNaN(buy) ? 0 : buy;
  const transport = costPerUnit(inputTransport) ?? 0;
  const contabil = costPerUnit(inputContabil) ?? 0;
  const costs = buyCost + transport + contabil;

  return roundPrice((costs + (pctTarget / 100) * minProfit) / factor);
}

function calcPretMinimProfit(pretCumparare) {
  if (inputProcentaj.value === "") return null;
  const pct = Number(inputProcentaj.value);
  if (Number.isNaN(pct) || pct >= 100) return null;

  const buy = Number(pretCumparare);
  const buyCost =
    pretCumparare == null || pretCumparare === "" || Number.isNaN(buy) ? 0 : buy;
  const transport = costPerUnit(inputTransport) ?? 0;
  const contabil = costPerUnit(inputContabil) ?? 0;
  const costs = buyCost + transport + contabil;
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

function syncMinProfitVsEmag(tr, salePrice, pretCumparare) {
  const minProfitCell = tr.querySelector("td[data-col='pret_minim_profit']");
  if (!minProfitCell) return;
  const minProfit = calcPretMinimProfit(pretCumparare);
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
  const derived = derivePrices(salePrice);

  const profitCell = tr.querySelector("td.col-profit");
  if (profitCell) {
    profitCell.dataset.salePrice = salePrice ?? "";
    profitCell.innerHTML = formatPrice(
      calcProfit(salePrice, pretCumparare),
      currency
    );
  }

  const procentajCell = tr.querySelector("td.col-procentaj-profit");
  if (procentajCell) {
    fillProcentajCell(procentajCell, calcProcentajProfit(salePrice, pretCumparare));
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
  const original = tr.dataset.originalSale ?? "";
  const isDirty =
    markDirty &&
    (!pricesEqual(salePrice, original) ||
      (derived.prp != null && !pricesEqual(derived.prp, tr.dataset.originalPrp)) ||
      (derived.min != null && !pricesEqual(derived.min, tr.dataset.originalMin)) ||
      (derived.max != null && !pricesEqual(derived.max, tr.dataset.originalMax)));
  tr.classList.toggle("is-price-dirty", isDirty);
  if (pretCell) pretCell.classList.toggle("is-price-dirty", isDirty);
  if (prpCell) prpCell.classList.toggle("is-price-dirty", isDirty);
  if (minCell) minCell.classList.toggle("is-price-dirty", isDirty);
  if (maxCell) maxCell.classList.toggle("is-price-dirty", isDirty);

  if (isDirty) {
    tr.classList.remove("is-just-synced");
    if (pretCell) pretCell.classList.remove("is-just-synced");
    if (prpCell) prpCell.classList.remove("is-just-synced");
    if (minCell) minCell.classList.remove("is-just-synced");
    if (maxCell) maxCell.classList.remove("is-just-synced");
  }

  syncMinProfitVsEmag(tr, salePrice, pretCumparare);
  syncPrpVsEmag(tr, salePrice);
  updateSyncButton();
}

function updateDerivedCells() {
  const transportFormatted = formatPrice(costPerUnit(inputTransport), "RON");
  const contabilFormatted = formatPrice(costPerUnit(inputContabil), "RON");
  tbody.querySelectorAll("td.col-pret-transport").forEach((cell) => {
    cell.innerHTML = transportFormatted;
  });
  tbody.querySelectorAll("td.col-pret-contabil").forEach((cell) => {
    cell.innerHTML = contabilFormatted;
  });

  tbody.querySelectorAll("tr[data-offer-id]").forEach((tr) => {
    const input = tr.querySelector("input.input-sale-price");
    if (!input) return;
    const sale = input.value;
    const pretCumparare = tr.dataset.pretCumparare ?? "";
    const currency = tr.dataset.currency || "RON";
    const minProfitCell = tr.querySelector("td[data-col='pret_minim_profit']");
    if (minProfitCell) {
      minProfitCell.innerHTML = formatPrice(
        calcPretMinimProfit(pretCumparare),
        currency
      );
    }
    applyRowPrices(tr, sale);
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
  const minProfit = calcPretMinimProfit(pretCumparare);
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
  const procentajVal = calcProcentajProfit(product.sale_price, product.pret_cumparare);
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
  return `<tr data-offer-id="${escapeHtml(product.id)}" data-original-sale="${escapeHtml(salePrice)}" data-pret-cumparare="${escapeHtml(pretCumparare)}" data-currency="${escapeHtml(currency)}" data-original-prp="${escapeHtml(product.recommended_price ?? "")}" data-original-min="${escapeHtml(product.min_sale_price ?? "")}" data-original-max="${escapeHtml(product.max_sale_price ?? "")}" data-status="${escapeHtml(product.status ?? "")}" data-vat-id="${escapeHtml(product.vat_id ?? "")}" data-stock="${stockJson}" data-handling-time="${handlingJson}">
    <td data-col="index"${cellClass("index")}>${index}</td>
    <td data-col="id"${cellClass("id")}>${escapeHtml(product.id)}</td>
    <td data-col="name"${cellClass("name")}>${escapeHtml(product.name) || "—"}</td>
    <td data-col="part_number"${cellClass("part_number")}>${escapeHtml(product.part_number) || "—"}</td>
    <td data-col="id_familie"${cellClass("id_familie")}>${escapeHtml(product.id_familie) || "—"}</td>
    <td data-col="familie"${cellClass("familie")}>${escapeHtml(product.familie) || "—"}</td>
    <td data-col="pret_cumparare"${cellClass("pret_cumparare")}>${formatPrice(product.pret_cumparare, "RON")}</td>
    <td data-col="pret_transport"${cellClass("pret_transport", "col-pret-transport")}>${formatPrice(costPerUnit(inputTransport), "RON")}</td>
    <td data-col="pret_contabil"${cellClass("pret_contabil", "col-pret-contabil")}>${formatPrice(costPerUnit(inputContabil), "RON")}</td>
    <td data-col="pret_minim_profit"${cellClass("pret_minim_profit", minProfitExtra)}>${formatPrice(minProfit, currency)}</td>
    <td data-col="pret_emag"${cellClass("pret_emag", "col-pret-emag")}><input type="number" class="input-sale-price" min="0" step="0.01" value="${escapeHtml(saleAttr)}" /></td>
    <td data-col="profit"${cellClass("profit", "col-profit")} data-sale-price="${escapeHtml(salePrice)}" data-pret-cumparare="${escapeHtml(pretCumparare)}" data-currency="${escapeHtml(currency)}">${formatPrice(calcProfit(product.sale_price, product.pret_cumparare), currency)}</td>
    <td data-col="procentaj_profit"${cellClass("procentaj_profit", procentajExtra)}><input type="number" class="input-procentaj-profit" step="0.01" value="${escapeHtml(procentajAttr)}" /></td>
    <td data-col="prp"${cellClass("prp", prpExtra)} data-value="${escapeHtml(product.recommended_price ?? "")}">${formatPrice(product.recommended_price, currency)}</td>
    <td data-col="pret_minim"${cellClass("pret_minim")} data-value="${escapeHtml(product.min_sale_price ?? "")}">${formatPrice(product.min_sale_price, currency)}</td>
    <td data-col="pret_maxim"${cellClass("pret_maxim")} data-value="${escapeHtml(product.max_sale_price ?? "")}">${formatPrice(product.max_sale_price, currency)}</td>
    <td data-col="stoc"${cellClass("stoc")}>${escapeHtml(product.general_stock ?? "—")}</td>
    <td data-col="status"${cellClass("status")}>${formatStatus(product.status)}</td>
    <td data-col="ean_pnk"${cellClass("ean_pnk")}>${eanPnk(product)}</td>
  </tr>`;
}

function renderProducts(products, append) {
  if (!append) {
    tbody.innerHTML = "";
  }

  if (!append && products.length === 0) {
    tbody.innerHTML =
      '<tr class="empty-row"><td colspan="17">Niciun produs găsit.</td></tr>';
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
      tbody.innerHTML = `<tr class="empty-row"><td colspan="17">${escapeHtml(
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
    const sale = saleFromProcentaj(pctInput.value, pretCumparare);
    if (sale == null) return;
    const saleInput = tr.querySelector("input.input-sale-price");
    if (saleInput) saleInput.value = String(sale);
    applyRowPrices(tr, sale);
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

function onSettingsInput() {
  updateDerivedCells();
  updateSaveDirtyState();
}

inputTransport.addEventListener("input", onSettingsInput);
inputContabil.addEventListener("input", onSettingsInput);
inputProcentaj.addEventListener("input", onSettingsInput);
inputNumarProduse.addEventListener("input", onSettingsInput);
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

colMenu.addEventListener("click", (e) => e.stopPropagation());

document.addEventListener("click", () => {
  if (!colMenu.hidden) setColumnMenuOpen(false);
});

buildColumnMenu();
applyColumnVisibility();
updateSyncButton();
loadSettings();
