const btnLoad = document.getElementById("btn-load");
const btnMore = document.getElementById("btn-more");
const btnSaveSettings = document.getElementById("btn-save-settings");
const btnColumns = document.getElementById("btn-columns");
const colMenu = document.getElementById("col-menu");
const statusEl = document.getElementById("status");
const tbody = document.getElementById("products-body");
const table = document.getElementById("products-table");
const inputTransport = document.getElementById("pret-transport");
const inputContabil = document.getElementById("pret-contabil");
const inputProcentaj = document.getElementById("procentaj-emag");
const inputNumarProduse = document.getElementById("numar-produse");

const HIDDEN_COLS_KEY = "emag-hidden-columns";

let currentPage = 1;
let loading = false;
let savingSettings = false;
let hiddenCols = loadHiddenCols();

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
}

function readSettingsFromForm() {
  return {
    pret_transport: inputTransport.value,
    pret_contabil: inputContabil.value,
    procentaj_emag: inputProcentaj.value,
    numar_produse: inputNumarProduse.value,
  };
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
  if (savingSettings) return;
  savingSettings = true;
  btnSaveSettings.disabled = true;
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
    btnSaveSettings.disabled = false;
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

function updateDerivedCells() {
  const transportFormatted = formatPrice(costPerUnit(inputTransport), "RON");
  const contabilFormatted = formatPrice(costPerUnit(inputContabil), "RON");
  tbody.querySelectorAll("td.col-pret-transport").forEach((cell) => {
    cell.innerHTML = transportFormatted;
  });
  tbody.querySelectorAll("td.col-pret-contabil").forEach((cell) => {
    cell.innerHTML = contabilFormatted;
  });
  tbody.querySelectorAll("td.col-profit").forEach((cell) => {
    const currency = cell.dataset.currency || "RON";
    cell.innerHTML = formatPrice(
      calcProfit(cell.dataset.salePrice, cell.dataset.pretCumparare),
      currency
    );
  });
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

function rowHtml(product, index) {
  const currency = product.currency || "RON";
  const salePrice = product.sale_price ?? "";
  const pretCumparare = product.pret_cumparare ?? "";
  const hidden = new Set(hiddenCols);
  const cellClass = (col, extra = "") => {
    const parts = [extra, hidden.has(col) ? "is-col-hidden" : ""].filter(Boolean);
    return parts.length ? ` class="${parts.join(" ")}"` : "";
  };
  return `<tr>
    <td data-col="index"${cellClass("index")}>${index}</td>
    <td data-col="id"${cellClass("id")}>${escapeHtml(product.id)}</td>
    <td data-col="name"${cellClass("name")}>${escapeHtml(product.name) || "—"}</td>
    <td data-col="part_number"${cellClass("part_number")}>${escapeHtml(product.part_number) || "—"}</td>
    <td data-col="pret_cumparare"${cellClass("pret_cumparare")}>${formatPrice(product.pret_cumparare, "RON")}</td>
    <td data-col="pret_transport"${cellClass("pret_transport", "col-pret-transport")}>${formatPrice(costPerUnit(inputTransport), "RON")}</td>
    <td data-col="pret_contabil"${cellClass("pret_contabil", "col-pret-contabil")}>${formatPrice(costPerUnit(inputContabil), "RON")}</td>
    <td data-col="pret_emag"${cellClass("pret_emag", "col-pret-emag")}>${formatPrice(product.sale_price, currency)}</td>
    <td data-col="profit"${cellClass("profit", "col-profit")} data-sale-price="${escapeHtml(salePrice)}" data-pret-cumparare="${escapeHtml(pretCumparare)}" data-currency="${escapeHtml(currency)}">${formatPrice(calcProfit(product.sale_price, product.pret_cumparare), currency)}</td>
    <td data-col="prp"${cellClass("prp")}>${formatPrice(product.recommended_price, currency)}</td>
    <td data-col="pret_minim"${cellClass("pret_minim")}>${formatPrice(product.min_sale_price, currency)}</td>
    <td data-col="pret_maxim"${cellClass("pret_maxim")}>${formatPrice(product.max_sale_price, currency)}</td>
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
      '<tr class="empty-row"><td colspan="15">Niciun produs găsit.</td></tr>';
    return;
  }

  const empty = tbody.querySelector(".empty-row");
  if (empty) empty.remove();

  const startIndex = tbody.querySelectorAll("tr:not(.empty-row)").length + 1;
  tbody.insertAdjacentHTML(
    "beforeend",
    products.map((p, i) => rowHtml(p, startIndex + i)).join("")
  );
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
      tbody.innerHTML = `<tr class="empty-row"><td colspan="15">${escapeHtml(
        err.message || "Eroare"
      )}</td></tr>`;
    }
  } finally {
    loading = false;
    btnLoad.disabled = false;
    btnMore.disabled = false;
  }
}

btnSaveSettings.addEventListener("click", saveSettings);
btnLoad.addEventListener("click", () => loadProducts({ append: false }));
btnMore.addEventListener("click", () => loadProducts({ append: true }));
inputTransport.addEventListener("input", updateDerivedCells);
inputContabil.addEventListener("input", updateDerivedCells);
inputProcentaj.addEventListener("input", updateDerivedCells);
inputNumarProduse.addEventListener("input", updateDerivedCells);

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
loadSettings();
