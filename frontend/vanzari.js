const btnLoad = document.getElementById("btn-load");
const btnMore = document.getElementById("btn-more");
const statusEl = document.getElementById("status");
const ordersBody = document.getElementById("orders-body");
const inputProcentajAlte = document.getElementById("procentaj-alte-costuri");
const displayProcentajAlte = document.getElementById("procentaj-alte-costuri-display");
const inputCreatedAfter = document.getElementById("created-after");
const inputCreatedBefore = document.getElementById("created-before");
const selectStatus = document.getElementById("order-status");
const inputTotalProfit = document.getElementById("total-profit-page");
const totalProfitLabel = document.getElementById("total-profit-label");

const DEFAULT_ALTE_COSTURI = 0;
const DEFAULT_PROcentaj_EMAG = 25;
const ORDERS_CACHE_KEY = "emag-orders-cache-v2";
const MAX_DATE_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 7;

const STATUS_LABELS = {
  0: "Anulat",
  1: "Nou",
  2: "În progres",
  3: "Preparat",
  4: "Finalizat",
  5: "Returnat",
};

const PAYMENT_LABELS = {
  1: "Ramburs",
  2: "Transfer",
  3: "Card online",
};

let currentPage = 0;
let hasMore = false;
let loading = false;
/** Filters used for the last successful load / restored cache */
let appliedFilters = null;
/** @type {Array<object>} */
let loadedOrders = [];

function setStatus(message, kind = "") {
  statusEl.textContent = message || "";
  statusEl.classList.remove("is-loading", "is-error", "is-ok");
  if (kind) statusEl.classList.add(`is-${kind}`);
}

function setStatusHtml(html, kind = "") {
  statusEl.innerHTML = html || "";
  statusEl.classList.remove("is-loading", "is-error", "is-ok");
  if (kind) statusEl.classList.add(`is-${kind}`);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showOrdersApiError(data, fallback) {
  if (data && data.code === "CREDENTIALS_MISSING") {
    const path = data.settingsPath || "/settings.html#emag";
    const msg = escapeHtml(data.error || "Credentiale eMAG lipsă.");
    setStatusHtml(
      `${msg} <a class="status-settings-link" href="${escapeHtml(path)}">Mergi la Setări</a>`,
      "error"
    );
    return;
  }
  const msgs = Array.isArray(data?.messages)
    ? data.messages.map((m) => m.message || JSON.stringify(m)).join("; ")
    : "";
  setStatus(
    [data?.error || fallback || "Eroare", msgs].filter(Boolean).join(" — "),
    "error"
  );
}

function formatPrice(price, currency) {
  if (price == null || price === "") return "—";
  const num = Number(price);
  if (Number.isNaN(num)) return escapeHtml(price);
  return `${num.toFixed(2)} ${escapeHtml(currency || "RON")}`;
}

function formatPctDisplay(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return String(n);
}

function parseAlteCosturi(raw) {
  if (raw == null || raw === "") return DEFAULT_ALTE_COSTURI;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_ALTE_COSTURI;
}

function alteFromProcentaj(procentaj, pretCumparare) {
  const buy = Number(pretCumparare);
  const pct = Number(procentaj);
  if (!Number.isFinite(buy) || buy <= 0 || !Number.isFinite(pct)) {
    return DEFAULT_ALTE_COSTURI;
  }
  return Math.round(buy * (pct / 100) * 100) / 100;
}

function resolveAlteCosturi(product) {
  if (product.transport_override != null && Number.isFinite(Number(product.transport_override))) {
    return Number(product.transport_override);
  }
  const pctRaw = inputProcentajAlte?.value;
  if (pctRaw == null || pctRaw === "") return DEFAULT_ALTE_COSTURI;
  const pct = Number(pctRaw);
  if (!Number.isFinite(pct)) return DEFAULT_ALTE_COSTURI;
  return alteFromProcentaj(pct, product.pret_cumparare);
}

function hasStoredProcentajEmag(product) {
  return (
    product.procentaj_emag != null && Number.isFinite(Number(product.procentaj_emag))
  );
}

function resolveProcentajEmag(product) {
  if (hasStoredProcentajEmag(product)) {
    return Number(product.procentaj_emag);
  }
  return DEFAULT_PROcentaj_EMAG;
}

function isBuyPriceMissing(pretCumparare) {
  if (pretCumparare == null || pretCumparare === "") return true;
  const buy = Number(pretCumparare);
  return Number.isNaN(buy);
}

function calcProfit(
  salePrice,
  pretCumparare,
  alteCosturi = DEFAULT_ALTE_COSTURI,
  pctEmag
) {
  if (pctEmag == null || pctEmag === "") return null;
  const pct = Number(pctEmag);
  if (salePrice == null || salePrice === "" || Number.isNaN(pct)) {
    return null;
  }
  if (isBuyPriceMissing(pretCumparare)) return null;

  const sale = Number(salePrice);
  if (Number.isNaN(sale)) return null;

  const afterEmag = sale * (1 - pct / 100);
  const buyCost = Number(pretCumparare);
  const other = parseAlteCosturi(alteCosturi);

  return afterEmag - buyCost - other;
}

function statusLabel(status) {
  const n = Number(status);
  return STATUS_LABELS[n] ?? String(status ?? "—");
}

function statusClass(status) {
  const n = Number(status);
  if (n === 0) return "status-badge status-cancelled";
  if (n === 1) return "status-badge status-new";
  if (n === 2) return "status-badge status-progress";
  if (n === 3) return "status-badge status-prepared";
  if (n === 4) return "status-badge status-finalized";
  if (n === 5) return "status-badge status-returned";
  return "status-badge";
}

function paymentLabel(id) {
  const n = Number(id);
  return PAYMENT_LABELS[n] ?? (id == null ? "—" : String(id));
}

function isOrderExcludedFromProfit(order) {
  const n = Number(order.status);
  return n === 0 || n === 5;
}

function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function setDefaultDateRange() {
  const before = new Date();
  const after = new Date(before.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  inputCreatedAfter.value = toDatetimeLocalValue(after);
  inputCreatedBefore.value = toDatetimeLocalValue(before);
}

function datetimeLocalToEmag(value) {
  if (!value) return null;
  // datetime-local: YYYY-MM-DDTHH:mm → eMAG YYYY-mm-dd HH:ii:ss
  const [date, time] = value.split("T");
  if (!date) return null;
  const hhmm = time && time.length >= 5 ? time.slice(0, 5) : "00:00";
  return `${date} ${hhmm}:00`;
}

function parseDatetimeLocalMs(value) {
  if (!value) return NaN;
  return Date.parse(value);
}

function validateDateRange() {
  const afterVal = inputCreatedAfter.value;
  const beforeVal = inputCreatedBefore.value;
  if (!afterVal || !beforeVal) return null;

  const after = parseDatetimeLocalMs(afterVal);
  const before = parseDatetimeLocalMs(beforeVal);
  if (!Number.isFinite(after) || !Number.isFinite(before)) return null;

  if (before < after) {
    return "„Până la” trebuie să fie după „De la”.";
  }
  if (before - after > MAX_DATE_RANGE_MS) {
    return "Intervalul de dată eMAG e max 31 zile.";
  }
  return null;
}

function buildQuery(page) {
  const params = new URLSearchParams();
  params.set("page", String(page));
  const after = datetimeLocalToEmag(inputCreatedAfter.value);
  const before = datetimeLocalToEmag(inputCreatedBefore.value);
  if (after) params.set("createdAfter", after);
  if (before) params.set("createdBefore", before);
  if (selectStatus.value !== "") params.set("status", selectStatus.value);
  return params.toString();
}

function currentFiltersSnapshot() {
  return {
    createdAfter: inputCreatedAfter.value || "",
    createdBefore: inputCreatedBefore.value || "",
    status: selectStatus.value || "",
  };
}

function filtersEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.createdAfter === b.createdAfter &&
    a.createdBefore === b.createdBefore &&
    a.status === b.status
  );
}

function saveOrdersCache() {
  try {
    const payload = {
      orders: loadedOrders,
      page: currentPage,
      hasMore,
      filters: currentFiltersSnapshot(),
      savedAt: new Date().toISOString(),
    };
    sessionStorage.setItem(ORDERS_CACHE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("cache comenzi:", err.message);
  }
}

function clearOrdersCache() {
  try {
    sessionStorage.removeItem(ORDERS_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

function readOrdersCache() {
  try {
    const raw = sessionStorage.getItem(ORDERS_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.orders)) return null;
    return data;
  } catch {
    return null;
  }
}

function restoreOrdersCache() {
  const data = readOrdersCache();
  if (!data || data.orders.length === 0) return false;

  if (data.filters) {
    inputCreatedAfter.value = data.filters.createdAfter || "";
    inputCreatedBefore.value = data.filters.createdBefore || "";
    selectStatus.value = data.filters.status || "";
  }

  loadedOrders = data.orders;
  currentPage = Number(data.page) || 1;
  hasMore = Boolean(data.hasMore);
  appliedFilters = currentFiltersSnapshot();

  renderOrders(loadedOrders, { append: false });
  updatePageProfitTotal();
  btnMore.hidden = !hasMore;

  const when = data.savedAt
    ? new Date(data.savedAt).toLocaleString("ro-RO")
    : "";
  setStatus(
    `Cache: ${loadedOrders.length} comenzi` +
      (when ? ` (din ${when})` : "") +
      " — Reload pentru date noi",
    "ok"
  );
  return true;
}

function productLineProfit(product) {
  if (Number(product.status) === 0) return null;
  if (isBuyPriceMissing(product.pret_cumparare)) return null;
  const alte = resolveAlteCosturi(product);
  const pctEmag = resolveProcentajEmag(product);
  const perUnit = calcProfit(
    product.sale_price,
    product.pret_cumparare,
    alte,
    pctEmag
  );
  if (perUnit == null || !Number.isFinite(perUnit)) return null;
  const qty = Number(product.quantity);
  const q = Number.isFinite(qty) && qty > 0 ? qty : 1;
  return { perUnit, total: perUnit * q, alte, qty: q, pctEmag };
}

function orderProfitTotal(order) {
  if (isOrderExcludedFromProfit(order)) return null;
  let sum = 0;
  let any = false;
  for (const p of order.products || []) {
    const line = productLineProfit(p);
    if (line == null) continue;
    sum += line.total;
    any = true;
  }
  return any ? sum : null;
}

function updatePageProfitTotal() {
  let sum = 0;
  let any = false;
  let counted = 0;
  for (const order of loadedOrders) {
    if (isOrderExcludedFromProfit(order)) continue;
    const t = orderProfitTotal(order);
    if (t == null || !Number.isFinite(t)) continue;
    sum += t;
    any = true;
    counted += 1;
  }
  inputTotalProfit.value = any ? `${sum.toFixed(2)} RON` : "—";
  if (totalProfitLabel) {
    totalProfitLabel.textContent =
      counted > 0
        ? `Total profit încărcat (${counted} comenzi)`
        : "Total profit încărcat";
  }
}

function renderProductRows(order) {
  const products = Array.isArray(order.products) ? order.products : [];
  if (products.length === 0) {
    return `<tr class="order-detail-row" data-parent-id="${escapeHtml(order.id)}">
      <td></td>
      <td colspan="7" class="order-products-empty">Niciun produs pe comandă.</td>
    </tr>`;
  }

  const head = `<tr class="order-detail-row order-detail-head" data-parent-id="${escapeHtml(order.id)}">
    <td></td>
    <td colspan="7">
      <table class="order-products-table">
        <thead>
          <tr>
            <th>Produs</th>
            <th>Part number</th>
            <th>Cant.</th>
            <th>Preț vânzare</th>
            <th>Preț cumpărare</th>
            <th>Pret transport</th>
            <th>Comision eMAG %</th>
            <th>Profit / buc</th>
            <th>Profit × cant.</th>
          </tr>
        </thead>
        <tbody>
          ${products
            .map((p) => {
              const line = productLineProfit(p);
              const alte = line?.alte ?? resolveAlteCosturi(p);
              const pctEmag = resolveProcentajEmag(p);
              const pctStored = hasStoredProcentajEmag(p);
              const currency = p.currency || "RON";
              const buyMissing = isBuyPriceMissing(p.pret_cumparare);
              const cancelled = Number(p.status) === 0;
              return `<tr class="${cancelled ? "product-cancelled" : ""}">
                <td>${escapeHtml(p.name || "—")}${cancelled ? ' <span class="muted">(anulat)</span>' : ""}</td>
                <td>${escapeHtml(p.part_number || "—")}</td>
                <td>${escapeHtml(p.quantity ?? "—")}</td>
                <td>${formatPrice(p.sale_price, currency)}</td>
                <td class="${buyMissing ? "is-missing" : ""}">${buyMissing ? "—" : formatPrice(p.pret_cumparare, currency)}</td>
                <td>${formatPrice(alte, currency)}</td>
                <td class="${pctStored ? "" : "is-missing"}" title="${pctStored ? "Comision din DB" : `Fallback ${DEFAULT_PROcentaj_EMAG}%`}">${escapeHtml(pctEmag.toFixed(2))}${pctStored ? "" : ' <span class="muted">(default)</span>'}</td>
                <td>${line ? formatPrice(line.perUnit, currency) : "—"}</td>
                <td>${line ? formatPrice(line.total, currency) : "—"}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </td>
  </tr>`;
  return head;
}

function renderOrders(orders, { append }) {
  if (!append) {
    ordersBody.innerHTML = "";
  }

  if (!append && orders.length === 0) {
    ordersBody.innerHTML = `<tr class="empty-row"><td colspan="8">Nicio comandă găsită pentru filtrele selectate.</td></tr>`;
    return;
  }

  const empty = ordersBody.querySelector(".empty-row");
  if (empty) empty.remove();

  const frag = document.createDocumentFragment();
  for (const order of orders) {
    const profit = orderProfitTotal(order);
    const currency = order.products?.[0]?.currency || "RON";
    const tr = document.createElement("tr");
    tr.className = "order-row";
    tr.dataset.orderId = String(order.id);
    tr.title = "Click pentru detalii";
    tr.innerHTML = `
      <td class="col-expand">
        <button type="button" class="btn-expand" aria-expanded="false" aria-label="Detalii comandă ${escapeHtml(order.id)}">▸</button>
      </td>
      <td>${escapeHtml(order.id)}</td>
      <td>${escapeHtml(order.date || "—")}</td>
      <td><span class="${statusClass(order.status)}">${escapeHtml(statusLabel(order.status))}</span></td>
      <td>${escapeHtml(order.customer_name || "—")}</td>
      <td>${escapeHtml(paymentLabel(order.payment_mode_id))}</td>
      <td>${escapeHtml((order.products || []).length)}</td>
      <td>${profit == null ? "—" : formatPrice(profit, currency)}</td>
    `;
    frag.appendChild(tr);
  }
  ordersBody.appendChild(frag);
}

function toggleOrderExpand(orderRow) {
  const orderId = orderRow.dataset.orderId;
  const btn = orderRow.querySelector(".btn-expand");
  const expanded = btn?.getAttribute("aria-expanded") === "true";

  const existing = ordersBody.querySelectorAll(
    `tr.order-detail-row[data-parent-id="${CSS.escape(orderId)}"]`
  );
  existing.forEach((r) => r.remove());

  if (expanded) {
    if (btn) {
      btn.setAttribute("aria-expanded", "false");
      btn.textContent = "▸";
    }
    orderRow.classList.remove("is-expanded");
    return;
  }

  const order = loadedOrders.find((o) => String(o.id) === String(orderId));
  if (!order) return;

  if (btn) {
    btn.setAttribute("aria-expanded", "true");
    btn.textContent = "▾";
  }
  orderRow.classList.add("is-expanded");

  const html = renderProductRows(order);
  orderRow.insertAdjacentHTML("afterend", html);
}

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Eroare setări");
    const alte =
      data.procentaj_alte_costuri != null ? data.procentaj_alte_costuri : "";
    inputProcentajAlte.value = alte;
    if (displayProcentajAlte) {
      displayProcentajAlte.textContent = formatPctDisplay(alte);
    }
  } catch (err) {
    console.warn("setări:", err.message);
  }
}

async function loadOrders({ append }) {
  if (loading) return;

  const rangeError = validateDateRange();
  if (rangeError) {
    setStatus(rangeError, "error");
    return;
  }

  loading = true;
  btnLoad.disabled = true;
  btnMore.disabled = true;
  setStatus("Se încarcă comenzile…", "loading");

  const page = append ? currentPage + 1 : 1;

  try {
    const res = await fetch(`/api/orders?${buildQuery(page)}`);
    const data = await res.json();
    if (!res.ok) {
      showOrdersApiError(data, `HTTP ${res.status}`);
      if (!append && loadedOrders.length === 0) {
        ordersBody.innerHTML = `<tr class="empty-row"><td colspan="8">${escapeHtml(
          data.error || "Eroare"
        )}</td></tr>`;
      }
      return;
    }

    const orders = Array.isArray(data.orders) ? data.orders : [];
    currentPage = data.page || page;
    hasMore = Boolean(data.hasMore);

    if (append) {
      loadedOrders = loadedOrders.concat(orders);
    } else {
      loadedOrders = orders;
    }

    appliedFilters = currentFiltersSnapshot();
    saveOrdersCache();
    renderOrders(orders, { append });
    updatePageProfitTotal();
    btnMore.hidden = !hasMore;
    setStatus(
      `Pagina ${currentPage}: ${orders.length} comenzi` +
        (data.authUsed ? ` (${data.authUsed})` : "") +
        " — cached până la Reload",
      "ok"
    );
  } catch (err) {
    setStatus(err.message || "Eroare la încărcare", "error");
    if (!append && loadedOrders.length === 0) {
      ordersBody.innerHTML = `<tr class="empty-row"><td colspan="8">${escapeHtml(err.message || "Eroare")}</td></tr>`;
      clearOrdersCache();
    }
  } finally {
    loading = false;
    btnLoad.disabled = false;
    btnMore.disabled = false;
  }
}

function onFiltersChanged() {
  const snapshot = currentFiltersSnapshot();
  const rangeError = validateDateRange();
  if (rangeError) {
    setStatus(rangeError, "error");
    return;
  }

  if (appliedFilters && !filtersEqual(snapshot, appliedFilters)) {
    setStatus("Filtre schimbate — se reîncarcă…", "loading");
    loadOrders({ append: false });
    return;
  }

  if (!appliedFilters && (snapshot.createdAfter || snapshot.createdBefore || snapshot.status)) {
    loadOrders({ append: false });
  }
}

btnLoad.addEventListener("click", () => loadOrders({ append: false }));
btnMore.addEventListener("click", () => loadOrders({ append: true }));

inputCreatedAfter.addEventListener("change", onFiltersChanged);
inputCreatedBefore.addEventListener("change", onFiltersChanged);
selectStatus.addEventListener("change", onFiltersChanged);

ordersBody.addEventListener("click", (e) => {
  const row = e.target.closest("tr.order-row");
  if (!row || !ordersBody.contains(row)) return;
  toggleOrderExpand(row);
});

(async () => {
  await loadSettings();
  if (!restoreOrdersCache()) {
    setDefaultDateRange();
    setStatus("Se încarcă ultimele 7 zile…", "loading");
    await loadOrders({ append: false });
  } else {
    updatePageProfitTotal();
  }
})();
