const listEl = document.getElementById("review-list");
const summaryEl = document.getElementById("review-summary");
const errorEl = document.getElementById("review-error");
const searchEl = document.getElementById("review-search");
const filterEl = document.getElementById("review-filter");
const reloadBtn = document.getElementById("btn-reload");
const pageEl = document.getElementById("review-page");
const loginEl = document.getElementById("review-login");
const loginForm = document.getElementById("review-login-form");
const passwordEl = document.getElementById("review-password");
const loginErrorEl = document.getElementById("review-login-error");
const logoutBtn = document.getElementById("btn-review-logout");
const TOKEN_KEY = "review-calls-token";

let orders = [];

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

function showLogin(message = "") {
  pageEl.hidden = true;
  loginEl.hidden = false;
  loginErrorEl.textContent = message;
  loginErrorEl.hidden = !message;
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

function orderMatches(order) {
  const filter = filterEl.value;
  if (filter === "uncalled" && order.called) return false;
  if (filter === "called" && !order.called) return false;
  if (filter === "romania" && !order.contact?.is_romania) return false;
  if (filter === "returned" && Number(order.status) !== 5) return false;
  const search = searchEl.value.trim().toLowerCase();
  if (!search) return true;
  const text = [
    order.id,
    order.customer_name,
    ...(order.contact?.phones || [order.contact?.phone]),
    order.contact?.city,
    ...((order.products || []).flatMap((p) => [p.name, p.part_number])),
  ].join(" ").toLowerCase();
  return text.includes(search);
}

function render() {
  const visible = orders.filter(orderMatches);
  const called = orders.filter((order) => order.called).length;
  summaryEl.textContent = `${visible.length} afișate · ${called}/${orders.length} sunate`;
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
    <article class="review-card ${order.called ? "is-called" : ""}" data-order-id="${escapeHtml(order.id)}">
      <div class="review-card-head">
        <label class="review-called">
          <input type="checkbox" class="called-checkbox" ${order.called ? "checked" : ""} />
          <span>Sunat</span>
        </label>
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
      </div>
    </div>`;
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
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Eroare la încărcarea comenzilor");
    orders = Array.isArray(data.orders) ? data.orders : [];
    render();
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
    listEl.innerHTML = `<div class="empty-row">Comenzile nu pot fi încărcate.</div>`;
    summaryEl.textContent = "";
  } finally {
    reloadBtn.disabled = false;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginErrorEl.hidden = true;
  const response = await fetch("/api/review-calls/auth", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: passwordEl.value }),
  });
  const data = await response.json();
  if (!response.ok) {
    showLogin(data.error || "Parola nu este corectă");
    return;
  }
  if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
  passwordEl.value = "";
  showPage();
  load();
});

logoutBtn.addEventListener("click", async () => {
  forgetAccess();
  await fetch("/api/review-calls/logout", { method: "POST", credentials: "same-origin" });
  showLogin();
});

searchEl.addEventListener("input", render);
filterEl.addEventListener("change", render);
reloadBtn.addEventListener("click", load);
load();
