const btnLoad = document.getElementById("btn-load");
const btnMore = document.getElementById("btn-more");
const statusEl = document.getElementById("status");
const tbody = document.getElementById("products-body");

let currentPage = 1;
let loading = false;

function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (type ? ` is-${type}` : "");
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
  return `<tr>
    <td>${index}</td>
    <td>${escapeHtml(product.id)}</td>
    <td>${escapeHtml(product.name) || "—"}</td>
    <td>${escapeHtml(product.part_number) || "—"}</td>
    <td>${formatPrice(product.sale_price, product.currency)}</td>
    <td>${formatPrice(product.pret_cumparare, "RON")}</td>
    <td>${escapeHtml(product.general_stock ?? "—")}</td>
    <td>${formatStatus(product.status)}</td>
    <td>${eanPnk(product)}</td>
  </tr>`;
}

function renderProducts(products, append) {
  if (!append) {
    tbody.innerHTML = "";
  }

  if (!append && products.length === 0) {
    tbody.innerHTML =
      '<tr class="empty-row"><td colspan="9">Niciun produs găsit.</td></tr>';
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
      tbody.innerHTML = `<tr class="empty-row"><td colspan="9">${escapeHtml(
        err.message || "Eroare"
      )}</td></tr>`;
    }
  } finally {
    loading = false;
    btnLoad.disabled = false;
    btnMore.disabled = false;
  }
}

btnLoad.addEventListener("click", () => loadProducts({ append: false }));
btnMore.addEventListener("click", () => loadProducts({ append: true }));
