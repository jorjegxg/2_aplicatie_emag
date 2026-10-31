const elTable = document.getElementById("fc-table");
const elKpis = document.getElementById("fc-kpis");
const elMix = document.getElementById("fc-mix");
const elPeriod = document.getElementById("fc-period");
const elMethod = document.getElementById("fc-method");
const elStatus = document.getElementById("fc-status");
const elImport = document.getElementById("fc-import");
const elSearch = document.getElementById("fc-search");
const elSort = document.getElementById("fc-sort");
const elTabs = document.getElementById("fc-tabs");
const elTabNote = document.getElementById("fc-tab-note");

const PREFS_KEY = "emag-prognoza-v2";
// Bara „Se vinde în” e liniară până la un an; peste, e plină și marcată.
const BAR_MAX_DAYS = 365;
const PLAN_DAYS = 60;

const STATE = {
  curand: { text: "Se termină curând", cls: "status-progress" },
  normal: { text: "Merge bine", cls: "status-finalized" },
  lent: { text: "Lent", cls: "status-returned" },
  epuizat: { text: "Epuizat", cls: "status-cancelled" },
  fara_vanzari: { text: "Fără vânzări", cls: "" },
  fara_stoc: { text: "Fără stoc", cls: "" },
};
const CHANNELS = [
  ["emag_ro", "RO", "eMAG România"],
  ["emag_hu", "HU", "eMAG Ungaria"],
  ["emag_bg", "BG", "eMAG Bulgaria"],
  ["trendyol", "TY", "Trendyol"],
];
const TABS = [
  {
    id: "vand",
    label: "Se vând",
    test: (i) => i.stock > 0 && i.units > 0,
    note: "Au stoc și s-au vândut măcar o dată. Cele care se termină primele sunt sus.",
  },
  {
    id: "epuizate",
    label: "Epuizate",
    test: (i) => i.stock <= 0 && i.units > 0,
    note: `S-au vândut și nu mai au stoc. „Pentru ${PLAN_DAYS} de zile” = câte bucăți ar ajunge la ritmul de până acum.`,
  },
  {
    id: "fara",
    label: "Fără vânzări",
    test: (i) => i.stock > 0 && i.units === 0,
    note: "Au stoc, dar nu s-au vândut niciodată. Nu se poate estima; banii stau blocați aici.",
  },
  { id: "toate", label: "Toate", test: () => true, note: "" },
];
const COLUMNS = [
  { key: "name", label: "Produs" },
  { key: "stock", label: "Stoc", num: true },
  { key: "units", label: "Vândute", num: true, title: "Bucăți vândute pe tot istoricul, fără anulate și returnate" },
  { key: "perMonth", label: "Pe lună", num: true, title: "Ritmul estimat, bucăți pe lună" },
  { key: "days", label: "Se vinde în", title: "Stoc ÷ ritm. Bara: până la un an." },
  { key: "confidence", label: "Încredere", title: "Câte vânzări stau la baza calculului: 1–2 slabă, 3–5 medie, 6+ bună" },
  { key: "state", label: "Stare" },
];
const SORTS = [
  ["days:1", "Se termină primele"],
  ["days:-1", "Se termină ultimele"],
  ["perMonth:-1", "Cele mai vândute pe lună"],
  ["units:-1", "Cele mai multe vânzări"],
  ["stock:-1", "Cel mai mult stoc"],
  ["name:1", "Nume A–Z"],
];

const prefs = (() => {
  const def = { tab: "vand", sort: "days", dir: 1 };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return def;
  }
})();
let data = null;

function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(message, kind = "") {
  elStatus.textContent = message || "";
  elStatus.classList.remove("is-loading", "is-error", "is-ok");
  if (kind) elStatus.classList.add(`is-${kind}`);
}

const nf = (n, d = 0) => Number(n).toLocaleString("ro-RO", { maximumFractionDigits: d, minimumFractionDigits: 0 });
const lei = (n) => `${nf(Math.round(n))} lei`;
const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : many}`;

function dateLabel(iso, withYear = true) {
  if (!iso) return "—";
  const d = new Date(iso);
  const opts = { day: "numeric", month: "short" };
  if (withYear && d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("ro-RO", opts);
}

/** „12 zile”, „3 luni”, „1,5 ani”. */
function durationLabel(days) {
  if (days == null) return "—";
  if (days < 1) return "sub o zi";
  if (days < 45) return plural(Math.round(days), "zi", "zile");
  if (days < 365) return `${nf(days / 30, 1)} luni`;
  return `${nf(days / 365, 1)} ani`;
}

const tabOf = (id) => TABS.find((t) => t.id === id) || TABS[0];

/* ------------------------------- sus ------------------------------- */

function kpi(label, value, sub, { hero = false } = {}) {
  return `<div class="kpi${hero ? " kpi-hero" : ""}">
    <div class="kpi-label">${escapeHtml(label)}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-sub"><span>${sub || ""}</span></div>
  </div>`;
}

function renderKpis() {
  const { totals: t, counts: c, items } = data;
  const soon = items.filter((i) => i.state === "curand").length;
  const soldOut = items.filter((i) => i.state === "epuizat").length;
  elKpis.innerHTML = [
    kpi(
      "Stocul care se vinde se termină în",
      durationLabel(t.daysForSelling),
      `la ritmul de acum, ${nf(t.perMonth, 1)} buc. pe lună`,
      { hero: true }
    ),
    kpi("Bucăți vândute", nf(t.units), `din ${plural(c.emag_orders + c.trendyol_orders, "comandă", "comenzi")} · eMAG ${nf(c.emag_orders)}, Trendyol ${nf(c.trendyol_orders)}`),
    kpi("De comandat", nf(soldOut + soon), soldOut || soon ? `${plural(soldOut, "epuizat", "epuizate")}, ${nf(soon)} se termină în 14 zile` : "nimic urgent"),
  ].join("");
}

/** Stocul pe grupe: cât se vinde repede, cât se vinde greu, cât nu s-a vândut deloc. */
function renderMix() {
  const groups = [
    { id: "fast", label: "Sub 2 luni", cls: "fc-seg-fast", test: (i) => i.state === "curand" || i.state === "normal" },
    { id: "slow", label: "Peste 2 luni", cls: "fc-seg-slow", test: (i) => i.state === "lent" },
    { id: "none", label: "Fără vânzări", cls: "fc-seg-none", test: (i) => i.state === "fara_vanzari" },
  ].map((g) => {
    const rows = data.items.filter(g.test);
    const pieces = rows.reduce((a, i) => a + i.stock, 0);
    const value = rows.reduce((a, i) => a + (i.stockValue || 0), 0);
    return { ...g, pieces, value, products: rows.length };
  });
  const total = groups.reduce((a, g) => a + g.pieces, 0) || 1;
  elPeriod.textContent = data.historyFrom
    ? `${nf(data.totals.stock)} buc. în stoc · vânzări din ${dateLabel(data.historyFrom)} (${nf(data.historyDays)} zile)`
    : "încă nicio vânzare";
  const bar = groups
    .filter((g) => g.pieces > 0)
    .map((g) => {
      const pct = (g.pieces / total) * 100;
      const tip = `${g.label}: ${nf(g.pieces)} buc. (${nf(pct)}%) la ${plural(g.products, "produs", "produse")} · ≈ ${lei(g.value)} la preț de cumpărare`;
      return `<div class="fc-seg ${g.cls}" style="flex-grow:${g.pieces}" title="${escapeHtml(tip)}"></div>`;
    })
    .join("");
  const legend = groups
    .map(
      (g) => `<li>
        <span class="fc-swatch ${g.cls}" aria-hidden="true"></span>
        <span class="fc-legend-label">${g.label}</span>
        <span class="fc-legend-val"><b>${nf((g.pieces / total) * 100)}%</b> · ${nf(g.pieces)} buc. · ${plural(g.products, "produs", "produse")}${g.value ? ` · ≈ ${lei(g.value)}` : ""}</span>
      </li>`
    )
    .join("");
  const none = groups.find((g) => g.id === "none");
  const callout = none.pieces
    ? `<p class="fc-mix-callout"><b>${nf((none.pieces / total) * 100)}% din stoc</b> nu s-a vândut niciodată${none.value ? ` — ≈ ${lei(none.value)} la preț de cumpărare, în ${plural(none.products, "produs", "produse")}` : ""}.</p>`
    : "";
  elMix.innerHTML = `<div class="fc-bar" role="img" aria-label="${escapeHtml(groups.map((g) => `${g.label} ${g.pieces} bucăți`).join(", "))}">${bar}</div>
    <ul class="fc-legend">${legend}</ul>${callout}`;
}

/* ------------------------------ tabel ------------------------------ */

function matchesSearch(item) {
  const q = elSearch.value.trim().toLowerCase();
  return !q || `${item.code} ${item.name}`.toLowerCase().includes(q);
}

function renderTabs() {
  elTabs.innerHTML = TABS.map((t) => {
    const n = data.items.filter((i) => t.test(i) && matchesSearch(i)).length;
    const on = t.id === prefs.tab;
    return `<button type="button" role="tab" class="fc-tab${on ? " is-active" : ""}" aria-selected="${on}" data-tab="${t.id}">
      ${t.label} <span class="fc-tab-count">${n}</span>
    </button>`;
  }).join("");
  elTabs.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      prefs.tab = b.dataset.tab;
      savePrefs();
      renderTabs();
      renderTable();
    })
  );
  elTabNote.textContent = tabOf(prefs.tab).note;
}

function sortValue(item, key) {
  if (key === "state") return Object.keys(STATE).indexOf(item.state);
  if (key === "confidence") return item.units;
  if (key === "name") return item.name || item.code;
  if (key === "days") return item.days;
  return item[key];
}

function compare(a, b) {
  const va = sortValue(a, prefs.sort);
  const vb = sortValue(b, prefs.sort);
  const tie = String(a.code).localeCompare(String(b.code));
  // Fără estimare: mereu la final, oricare ar fi sensul.
  if (va == null && vb == null) return b.perMonth - a.perMonth || (b.stockValue || 0) - (a.stockValue || 0) || tie;
  if (va == null) return 1;
  if (vb == null) return -1;
  const r = typeof va === "string" ? va.localeCompare(vb, "ro") : va - vb;
  return r * prefs.dir || tie;
}

function channelChips(item) {
  const chips = CHANNELS.filter(([k]) => item.channels[k]).map(
    ([k, short, long]) => `<span class="fc-chip" title="${long}: ${nf(item.channels[k])} buc.">${short} ${nf(item.channels[k])}</span>`
  );
  return chips.length ? `<span class="fc-chips">${chips.join("")}</span>` : "";
}

function daysCell(item) {
  if (item.state === "epuizat") {
    const need = Math.max(1, Math.ceil(item.rate * PLAN_DAYS));
    return `<div class="fc-days-text"><b>Pentru ${PLAN_DAYS} de zile: ≈ ${plural(need, "bucată", "bucăți")}</b></div>
      <div class="fc-sub">ultima vânzare ${dateLabel(item.lastSale)}</div>`;
  }
  if (item.state === "fara_vanzari") {
    const money = item.stockValue ? `<b>≈ ${lei(item.stockValue)} blocați</b>` : `<span class="muted">nu se poate estima</span>`;
    return `<div class="fc-days-text">${money}</div>
      <div class="fc-sub">nicio vânzare în ${nf(data.historyDays)} de zile</div>`;
  }
  if (item.days == null) return `<span class="muted">—</span>`;
  const pct = Math.min(1, item.days / BAR_MAX_DAYS) * 100;
  const over = item.days > BAR_MAX_DAYS;
  const tip = `${durationLabel(item.days)} · până pe ${dateLabel(item.soldOutAt)} · ritm ${nf(item.perMonth, 1)} buc./lună`;
  return `<div class="fc-days" title="${escapeHtml(tip)}">
    <div class="fc-days-text"><b>${durationLabel(item.days)}</b> <span class="fc-sub">până pe ${dateLabel(item.soldOutAt)}</span></div>
    <div class="fc-track"><div class="fc-fill${over ? " is-over" : ""}" style="width:${pct}%"></div></div>
  </div>`;
}

function confidenceCell(item) {
  const level = item.units >= 6 ? 3 : item.units >= 3 ? 2 : item.units >= 1 ? 1 : 0;
  if (!level) return `<span class="muted">—</span>`;
  const dots = [1, 2, 3].map((n) => `<i class="${n <= level ? "is-on" : ""}"></i>`).join("");
  return `<span class="fc-conf" title="${plural(item.units, "vânzare", "vânzări")} la baza calculului"><span class="fc-dots" aria-hidden="true">${dots}</span>${escapeHtml(item.confidence)}</span>`;
}

function renderTable() {
  const tab = tabOf(prefs.tab);
  const items = data.items.filter((i) => tab.test(i) && matchesSearch(i)).sort(compare);
  if (!items.length) {
    const q = elSearch.value.trim();
    elTable.innerHTML = `<div class="fc-empty">${q ? `Niciun produs pentru „${escapeHtml(q)}” aici.` : "Niciun produs aici."}</div>`;
    return;
  }
  const head = COLUMNS.map((c) => {
    const on = prefs.sort === c.key;
    const aria = on ? (prefs.dir > 0 ? "ascending" : "descending") : "none";
    return `<th scope="col" class="is-sortable${c.num ? " is-num" : ""}${on ? " is-sorted" : ""}" data-sort="${c.key}" aria-sort="${aria}" ${c.title ? `title="${escapeHtml(c.title)}"` : ""}>
      ${c.num ? `<span class="fc-arrow" aria-hidden="true">${on ? (prefs.dir > 0 ? "▲" : "▼") : ""}</span>` : ""}${c.label}${c.num ? "" : `<span class="fc-arrow" aria-hidden="true">${on ? (prefs.dir > 0 ? "▲" : "▼") : ""}</span>`}</th>`;
  }).join("");
  const body = items
    .map((it) => {
      const st = STATE[it.state] || { text: it.state, cls: "" };
      return `<tr class="fc-row fc-row-${it.state}">
        <td class="fc-product" data-label="Produs">
          <div class="fc-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name || it.code)}</div>
          <div class="fc-code">${escapeHtml(it.code)}</div>
        </td>
        <td class="is-num" data-label="Stoc"><b>${nf(it.stock)}</b></td>
        <td class="is-num" data-label="Vândute">${nf(it.units)}${channelChips(it)}</td>
        <td class="is-num" data-label="Pe lună">${it.units ? nf(it.perMonth, 1) : "—"}${it.recent ? `<div class="fc-sub">${nf(it.recent)} în 30 zile</div>` : ""}</td>
        <td class="fc-days-cell" data-label="Se vinde în">${daysCell(it)}</td>
        <td data-label="Încredere">${confidenceCell(it)}</td>
        <td data-label="Stare"><span class="status-badge ${st.cls}">${st.text}</span></td>
      </tr>`;
    })
    .join("");
  elTable.innerHTML = `<table class="stats-table fc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  elTable.querySelectorAll("th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      prefs.dir = prefs.sort === key ? -prefs.dir : key === "name" || key === "days" ? 1 : -1;
      prefs.sort = key;
      savePrefs();
      syncSortSelect();
      renderTable();
    })
  );
}

function syncSortSelect() {
  const v = `${prefs.sort}:${prefs.dir}`;
  if (!SORTS.some(([k]) => k === v)) {
    const col = COLUMNS.find((c) => c.key === prefs.sort);
    elSort.querySelector("[data-custom]")?.remove();
    elSort.insertAdjacentHTML("beforeend", `<option value="${v}" data-custom>${col ? col.label : prefs.sort} ${prefs.dir > 0 ? "↑" : "↓"}</option>`);
  }
  elSort.value = v;
}

function renderMethod() {
  const c = data.counts;
  const unlinked = c.emag_unlinked + c.trendyol_unlinked;
  elMethod.innerHTML =
    `Ritmul pe zi e media dintre ritmul pe tot istoricul (${nf(data.historyDays)} de zile) și ritmul din ultimele ${nf(data.recentDays)} de zile, ` +
    `ca să prindă dacă un produs a pornit sau s-a oprit. Zilele = stoc ÷ ritm. ` +
    `Nu intră anulările, returnările și comanda falsă 534856443. ` +
    `Încrederea arată pe câte vânzări stă calculul: cu 1–2 vânzări estimarea e orientativă.` +
    (unlinked ? ` ${plural(unlinked, "linie", "linii")} de comandă nu ${unlinked === 1 ? "s-a legat" : "s-au legat"} de niciun produs din catalog.` : "");
}

function render() {
  renderKpis();
  renderMix();
  renderTabs();
  renderTable();
  renderMethod();
}

/* ------------------------------ date ------------------------------- */

async function load() {
  setStatus("Se încarcă…", "loading");
  try {
    const res = await fetch("/api/forecast");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    data = json;
    render();
    setStatus("");
  } catch (e) {
    setStatus(e.message, "error");
  }
}

async function importHistory() {
  elImport.disabled = true;
  elImport.classList.add("is-busy");
  setStatus("Citesc toate comenzile din eMAG RO/HU/BG și Trendyol…", "loading");
  try {
    const res = await fetch("/api/orders/import-history", { method: "POST" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    const e = json.emag;
    await load();
    setStatus(`Gata: eMAG RO ${e.ro.saved + e.ro.skipped}, HU ${e.hu.saved + e.hu.skipped}, BG ${e.bg.saved + e.bg.skipped} comenzi · Trendyol ${json.trendyol.packages} colete`, "ok");
  } catch (e) {
    setStatus(e.message, "error");
  } finally {
    elImport.disabled = false;
    elImport.classList.remove("is-busy");
  }
}

elSort.innerHTML = SORTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
syncSortSelect();
elSort.addEventListener("change", () => {
  const [key, dir] = elSort.value.split(":");
  prefs.sort = key;
  prefs.dir = Number(dir);
  savePrefs();
  if (data) renderTable();
});
elSearch.addEventListener("input", () => {
  if (!data) return;
  renderTabs();
  renderTable();
});
elImport.addEventListener("click", importHistory);

load();
