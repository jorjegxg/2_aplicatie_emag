const btnLoad = document.getElementById("btn-load");
const btnMore = document.getElementById("btn-more");
const statusEl = document.getElementById("status");
const ordersBody = document.getElementById("orders-body");
const inputProcentajAlte = document.getElementById("procentaj-alte-costuri");
const inputProcentajContabil = document.getElementById("procentaj-pret-contabil");
const inputCreatedAfter = document.getElementById("created-after");
const inputCreatedBefore = document.getElementById("created-before");
const selectStatus = document.getElementById("order-status");
const inputTotalProfit = document.getElementById("total-profit-page");

const DEFAULT_ALTE_COSTURI = 0;
const DEFAULT_PRET_CONTABIL = 0;
const ORDERS_CACHE_KEY = "emag-orders-cache-v1";

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
/** @type {Array<object>} */
let loadedOrders = [];

function setStatus(message, kind = "") {
  statusEl.textContent = message || "";
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

function formatPrice(price, currency) {
  if (price == null || price === "") return "—";
  const num = Number(price);
  if (Number.isNaN(num)) return escapeHtml(price);
  return `${num.toFixed(2)} ${escapeHtml(currency || "RON")}`;
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

function resolveAlteCosturi(product) {
  if (product.alte_costuri != null && Number.isFinite(Number(product.alte_costuri))) {
    return Number(product.alte_costuri);
  }
  const pctRaw = inputProcentajAlte?.value;
  if (pctRaw == null || pctRaw === "") return DEFAULT_ALTE_COSTURI;
  const pct = Number(pctRaw);
  if (!Number.isFinite(pct)) return DEFAULT_ALTE_COSTURI;
  return alteFromProcentaj(pct, product.pret_cumparare);
}

function resolvePretContabil(product) {
  if (product.pret_contabil != null && Number.isFinite(Number(product.pret_contabil))) {
    return Number(product.pret_contabil);
  }
  const pctRaw = inputProcentajContabil?.value;
  if (pctRaw == null || pctRaw === "") return DEFAULT_PRET_CONTABIL;
  const pct = Number(pctRaw);
  if (!Number.isFinite(pct)) return DEFAULT_PRET_CONTABIL;
  return contabilFromProcentaj(pct, product.pret_cumparare);
}

const DEFAULT_PROcentaj_EMAG = 25;

function resolveProcentajEmag(product) {
  if (product.procentaj_emag != null && Number.isFinite(Number(product.procentaj_emag))) {
    return Number(product.procentaj_emag);
  }
  return DEFAULT_PROcentaj_EMAG;
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

function datetimeLocalToEmag(value) {
  if (!value) return null;
  // datetime-local: YYYY-MM-DDTHH:mm → eMAG YYYY-mm-dd HH:ii:ss
  const [date, time] = value.split("T");
  if (!date) return null;
  const hhmm = time && time.length >= 5 ? time.slice(0, 5) : "00:00";
  return `${date} ${hhmm}:00`;
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
  const alte = resolveAlteCosturi(product);
  const contabil = resolvePretContabil(product);
  const pctEmag = resolveProcentajEmag(product);
  const perUnit = calcProfit(
    product.sale_price,
    product.pret_cumparare,
    alte,
    contabil,
    pctEmag
  );
  if (perUnit == null || !Number.isFinite(perUnit)) return null;
  const qty = Number(product.quantity);
  const q = Number.isFinite(qty) && qty > 0 ? qty : 1;
  return { perUnit, total: perUnit * q, alte, contabil, qty: q };
}

function orderProfitTotal(order) {
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
  for (const order of loadedOrders) {
    const t = orderProfitTotal(order);
    if (t == null || !Number.isFinite(t)) continue;
    sum += t;
    any = true;
  }
  inputTotalProfit.value = any ? `${sum.toFixed(2)} RON` : "—";
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
            <th>Pret contabil</th>
            <th>Profit / buc</th>
            <th>Profit × cant.</th>
          </tr>
        </thead>
        <tbody>
          ${products
            .map((p) => {
              const line = productLineProfit(p);
              const alte = line?.alte ?? resolveAlteCosturi(p);
              const contabil = line?.contabil ?? resolvePretContabil(p);
              const currency = p.currency || "RON";
              const buyMissing =
                p.pret_cumparare == null || p.pret_cumparare === "";
              const cancelled = Number(p.status) === 0;
              return `<tr class="${cancelled ? "product-cancelled" : ""}">
                <td>${escapeHtml(p.name || "—")}${cancelled ? ' <span class="muted">(anulat)</span>' : ""}</td>
                <td>${escapeHtml(p.part_number || "—")}</td>
                <td>${escapeHtml(p.quantity ?? "—")}</td>
                <td>${formatPrice(p.sale_price, currency)}</td>
                <td class="${buyMissing ? "is-missing" : ""}">${buyMissing ? "—" : formatPrice(p.pret_cumparare, currency)}</td>
                <td>${formatPrice(alte, currency)}</td>
                <td>${formatPrice(contabil, currency)}</td>
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
    const currency =
      order.products?.[0]?.currency || "RON";
    const tr = document.createElement("tr");
    tr.className = "order-row";
    tr.dataset.orderId = String(order.id);
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
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "▸";
    orderRow.classList.remove("is-expanded");
    return;
  }

  const order = loadedOrders.find((o) => String(o.id) === String(orderId));
  if (!order) return;

  btn.setAttribute("aria-expanded", "true");
  btn.textContent = "▾";
  orderRow.classList.add("is-expanded");

  const html = renderProductRows(order);
  orderRow.insertAdjacentHTML("afterend", html);
}

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Eroare setări");
    inputProcentajAlte.value =
      data.procentaj_alte_costuri != null ? data.procentaj_alte_costuri : "";
    if (inputProcentajContabil) {
      inputProcentajContabil.value =
        data.procentaj_pret_contabil != null ? data.procentaj_pret_contabil : "";
    }
  } catch (err) {
    console.warn("setări:", err.message);
  }
}

async function loadOrders({ append }) {
  if (loading) return;
  loading = true;
  btnLoad.disabled = true;
  btnMore.disabled = true;
  setStatus("Se încarcă comenzile…", "loading");

  const page = append ? currentPage + 1 : 1;

  try {
    const res = await fetch(`/api/orders?${buildQuery(page)}`);
    const data = await res.json();
    if (!res.ok) {
      const msgs = Array.isArray(data.messages)
        ? data.messages.map((m) => m.message || JSON.stringify(m)).join("; ")
        : "";
      throw new Error(
        [data.error || `HTTP ${res.status}`, msgs].filter(Boolean).join(" — ")
      );
    }

    const orders = Array.isArray(data.orders) ? data.orders : [];
    currentPage = data.page || page;
    hasMore = Boolean(data.hasMore);

    if (append) {
      loadedOrders = loadedOrders.concat(orders);
    } else {
      loadedOrders = orders;
    }

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

btnLoad.addEventListener("click", () => loadOrders({ append: false }));
btnMore.addEventListener("click", () => loadOrders({ append: true }));

ordersBody.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-expand");
  if (!btn) return;
  const row = btn.closest("tr.order-row");
  if (row) toggleOrderExpand(row);
});

(async () => {
  await loadSettings();
  if (!restoreOrdersCache()) {
    setStatus("Apasă Reload comenzi — sau rămâi pe cache după încărcare.", "");
  } else {
    updatePageProfitTotal();
  }
})();
