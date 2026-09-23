const listEl = document.getElementById("review-list");
const summaryEl = document.getElementById("review-summary");
const errorEl = document.getElementById("review-error");
const searchEl = document.getElementById("review-search");
const filtersEl = document.querySelector(".review-filters");
const filtersSizeBtn = document.getElementById("btn-review-filters-size");
const toolbarEl = document.querySelector(".review-toolbar");
const reloadBtn = document.getElementById("btn-reload");
const pageEl = document.getElementById("review-page");
const loginEl = document.getElementById("review-login");
const passwordEl = document.getElementById("review-password");
const loginErrorEl = document.getElementById("review-login-error");
const logoutBtn = document.getElementById("btn-review-logout");
const TOKEN_KEY = "review-calls-token";
const FILTERS_COMPACT_KEY = "review-filters-compact";

const FILTER_LABELS = {
  all: "Fără returnate, BG și HU",
  uncalled: "Nesunați, fără BG, HU, retur",
  called: "Sunați",
  romania: "România",
  returned: "Returnate",
  everything: "Toate",
  reviewed: "Cu review",
};

let orders = [];
let activeFilter = "all";
let filtersCompact = localStorage.getItem(FILTERS_COMPACT_KEY) === "1";

function authHeaders(extra = {}) {
  const headers = { ...extra };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function forgetAccess() {
  localStorage.removeItem(TOKEN_KEY);
}

function showPage() {
  loginEl.hidden = true;
  pageEl.hidden = false;
}

function takeLoginError() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("login") !== "eroare") return "";
  params.delete("login");
  const query = params.toString();
  history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash);
  return "Parola nu este corectă";
}

let pendingLoginError = takeLoginError();

function showLogin(message = "") {
  const text = message || pendingLoginError;
  pendingLoginError = "";
  pageEl.hidden = true;
  loginEl.hidden = false;
  loginErrorEl.textContent = text;
  loginErrorEl.hidden = !text;
  passwordEl.focus();
}

const STATUS_LABELS = {
  0: "Anulat",
  1: "Nou",
  2: "În progres",
  3: "Preparat",
  4: "Finalizat",
  5: "Returnat",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ro-RO");
}

function formatPrice(value, currency = "RON") {
  if (value == null || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)} ${currency}` : "—";
}

function statusLabel(value) {
  return STATUS_LABELS[Number(value)] || "Necunoscut";
}

function isReturned(order) {
  return Number(order.status) === 5;
}

function isBgOrHu(order) {
  const contact = order.contact || {};
  const blob = [contact.country_code, contact.country, order.channel, order.currency]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    /\b(bg|bgr|bulgaria|bgn)\b/.test(blob) ||
    /\b(hu|hun|hungary|ungaria|huf|magyarorszag|magyarország)\b/.test(blob) ||
    blob.includes("emag_bg") ||
    blob.includes("emag_hu") ||
    blob.includes("emag-bg") ||
    blob.includes("emag-hu")
  );
}

function orderMatches(order) {
  const filter = activeFilter;
  if (filter === "all" && (isReturned(order) || isBgOrHu(order))) return false;
  if (filter === "uncalled" && (order.called || isReturned(order) || isBgOrHu(order))) return false;
  if (filter === "called" && !order.called) return false;
  if (filter === "romania" && !order.contact?.is_romania) return false;
  if (filter === "returned" && !isReturned(order)) return false;
  if (filter === "reviewed" && !(order.customer_reviews || []).length) return false;
  const search = searchEl.value.trim().toLowerCase();
  if (!search) return true;
  const text = [
    order.id,
    order.customer_name,
    ...(order.contact?.phones || [order.contact?.phone]),
    order.contact?.city,
    ...((order.products || []).flatMap((p) => [p.name, p.part_number])),
    ...((order.customer_reviews || []).flatMap((review) => [review.title, review.content, review.author])),
  ].join(" ").toLowerCase();
  return text.includes(search);
}

function render() {
  const visible = orders.filter(orderMatches);
  const called = orders.filter((order) => order.called).length;
  const reviewed = orders.filter((order) => (order.customer_reviews || []).length).length;
  summaryEl.textContent = `${visible.length} afișate · ${called}/${orders.length} sunate · ${reviewed} cu review`;
  if (!visible.length) {
    listEl.innerHTML = `<div class="empty-row">Nu există comenzi pentru filtrul selectat.</div>`;
    return;
  }
  listEl.innerHTML = visible.map(renderOrder).join("");
}

function renderOrder(order) {
  const contact = order.contact || {};
  const phones = Array.isArray(contact.phones) && contact.phones.length
    ? contact.phones
    : contact.phone
      ? [contact.phone]
      : [];
  const products = order.products || [];
  return `
    <article class="review-card ${order.called ? "is-called" : ""} ${(order.customer_reviews || []).length ? "has-review" : ""}" data-order-id="${escapeHtml(order.id)}">
      <div class="review-card-head">
        <label class="review-called">
          <input type="checkbox" class="called-checkbox" ${order.called ? "checked" : ""} />
          <span>Sunat</span>
        </label>
        ${(order.customer_reviews || []).length ? `<span class="review-left-badge">Review</span>` : ""}
        <span class="review-order-id">Comanda #${escapeHtml(order.id)}</span>
        <span class="status-badge ${Number(order.status) === 5 ? "status-returned" : ""}">${escapeHtml(statusLabel(order.status))}</span>
        <time>${escapeHtml(formatDate(order.date))}</time>
      </div>
      <div class="review-customer">
        <strong>${escapeHtml(order.customer_name || "Client fără nume")}</strong>
        ${phones.length
          ? `<div class="review-phones">${phones.map((phone) => `
              <span class="review-phone-item">
                <a class="review-phone" href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>
                <button type="button" class="btn btn-small copy-btn" data-copy="${escapeHtml(phone)}">Copiază</button>
              </span>`).join("")}</div>`
          : `<span class="muted">Telefon indisponibil</span>`}
        <span class="review-country">${contact.is_romania ? "🇷🇴 România" : escapeHtml(contact.country || "Țară necunoscută")}</span>
        ${contact.city ? `<span class="muted">${escapeHtml(contact.city)}</span>` : ""}
      </div>
      <div class="review-products">
        ${products.length ? products.map(renderProduct).join("") : `<span class="muted">Niciun produs salvat pe comandă</span>`}
      </div>
    </article>`;
}

function renderProduct(product) {
  const reviewButton = product.review_url
    ? `<button type="button" class="btn btn-small copy-btn" data-copy="${escapeHtml(product.review_url)}">Copiază link review</button>
       <a class="btn btn-small btn-secondary" href="${escapeHtml(product.review_url)}" target="_blank" rel="noopener noreferrer">Deschide review</a>`
    : `<span class="muted">Link review indisponibil</span>`;
  return `
    <div class="review-product">
      ${product.image_url ? `<img class="review-product-image" src="${escapeHtml(product.image_url)}" alt="" loading="lazy" />` : `<div class="review-product-image review-product-placeholder">—</div>`}
      <div class="review-product-info">
        <strong>${escapeHtml(product.name || "Produs fără nume")}</strong>
        <span class="muted">${escapeHtml(product.part_number || "Fără cod")} · Cant. ${escapeHtml(product.quantity ?? "—")}</span>
        <span class="review-price">${escapeHtml(formatPrice(product.sale_price, product.currency))}</span>
        <div class="review-actions">${reviewButton}</div>
        ${renderGivenReviews(product.customer_reviews)}
      </div>
    </div>`;
}

function stars(rating) {
  const filled = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return `${"★".repeat(filled)}${"☆".repeat(5 - filled)}`;
}

function renderGivenReviews(reviews) {
  if (!Array.isArray(reviews) || !reviews.length) return "";
  return reviews.map((review) => `
    <div class="review-given">
      <div class="review-given-head">
        <span class="review-stars" aria-label="${escapeHtml(review.rating)} din 5">${stars(review.rating)}</span>
        <strong>Review lăsat</strong>
        <time>${escapeHtml(formatDate(review.created))}</time>
      </div>
      ${review.title ? `<div class="review-given-title">${escapeHtml(review.title)}</div>` : ""}
      <p>${escapeHtml(review.content || "Fără text, doar notă.")}</p>
    </div>`).join("");
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  const original = button.textContent;
  button.textContent = "Copiat";
  setTimeout(() => { button.textContent = original; }, 1200);
}

async function updateCalled(orderId, called, card) {
  const response = await fetch(`/api/review-calls/${encodeURIComponent(orderId)}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ called }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Bifa nu a putut fi salvată");
  const order = orders.find((item) => String(item.id) === String(orderId));
  if (order) order.called = called;
  card.classList.toggle("is-called", called);
  render();
}

listEl.addEventListener("click", (event) => {
  const button = event.target.closest(".copy-btn");
  if (button) copyText(button.dataset.copy, button);
});

listEl.addEventListener("change", async (event) => {
  const checkbox = event.target.closest(".called-checkbox");
  if (!checkbox) return;
  const card = checkbox.closest(".review-card");
  checkbox.disabled = true;
  try {
    await updateCalled(card.dataset.orderId, checkbox.checked, card);
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  } finally {
    checkbox.disabled = false;
  }
});

async function load() {
  reloadBtn.disabled = true;
  errorEl.hidden = true;
  errorEl.classList.add("is-error");
  summaryEl.textContent = "Se încarcă…";
  try {
    const response = await fetch("/api/review-calls?limit=10000", {
      cache: "no-store",
      credentials: "same-origin",
      headers: authHeaders(),
    });
    if (response.status === 401) {
      forgetAccess();
      showLogin();
      return;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Eroare la încărcarea comenzilor");
    }
    showPage();
    const data = await response.json();
    orders = Array.isArray(data.orders) ? data.orders : [];
    render();
    if (data.reviews_note) {
      errorEl.textContent = data.reviews_note;
      errorEl.classList.remove("is-error");
      errorEl.hidden = false;
    }
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
    listEl.innerHTML = `<div class="empty-row">Comenzile nu pot fi încărcate.</div>`;
    summaryEl.textContent = "";
  } finally {
    reloadBtn.disabled = false;
  }
}

logoutBtn.addEventListener("click", async () => {
  forgetAccess();
  await fetch("/api/review-calls/logout", { method: "POST", credentials: "same-origin" });
  showLogin();
});

function syncFiltersSize() {
  toolbarEl.classList.toggle("is-filters-compact", filtersCompact);
  filtersSizeBtn.setAttribute("aria-expanded", filtersCompact ? "false" : "true");
  const label = FILTER_LABELS[activeFilter] || "Filtre";
  filtersSizeBtn.textContent = filtersCompact ? `${label} ▾` : "Micșorează filtrele";
  filtersSizeBtn.setAttribute(
    "aria-label",
    filtersCompact ? `Deschide filtrele. Acum: ${label}` : "Micșorează filtrele"
  );
}

function setFiltersCompact(on) {
  filtersCompact = on;
  localStorage.setItem(FILTERS_COMPACT_KEY, on ? "1" : "0");
  syncFiltersSize();
}

function setFilter(value) {
  activeFilter = value;
  filtersEl.querySelectorAll(".review-chip").forEach((chip) => {
    const on = chip.dataset.filter === value;
    chip.classList.toggle("is-active", on);
    chip.setAttribute("aria-pressed", on ? "true" : "false");
  });
  syncFiltersSize();
  render();
}

searchEl.addEventListener("input", render);
filtersSizeBtn.addEventListener("click", () => setFiltersCompact(!filtersCompact));
syncFiltersSize();
filtersEl.addEventListener("click", (event) => {
  const chip = event.target.closest(".review-chip");
  if (!chip || chip.dataset.filter === activeFilter) return;
  setFilter(chip.dataset.filter);
});
reloadBtn.addEventListener("click", load);
load();
