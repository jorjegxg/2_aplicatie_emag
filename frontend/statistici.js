const elFrom = document.getElementById("stats-from");
const elTo = document.getElementById("stats-to");
const elPlatform = document.getElementById("stats-platform");
const elReload = document.getElementById("stats-reload");
const elStatus = document.getElementById("stats-status");
const tooltip = document.getElementById("stats-tooltip");

const PREFS_KEY = "emag-stats-prefs-v1";
const PLATFORM_LABELS = { ro: "România", hu: "Ungaria", bg: "Bulgaria" };
const WEEKDAYS = ["Lun", "Mar", "Mie", "Joi", "Vin", "Sâm", "Dum"];
const MONTHS = ["ian", "feb", "mar", "apr", "mai", "iun", "iul", "aug", "sep", "oct", "noi", "dec"];
/** Peste atatea zile graficele trec pe saptamani. */
const WEEK_BUCKET_AFTER_DAYS = 45;

const STOCK_STATES = {
  nevandut: { label: "Nevândut", cls: "status-returned", hint: "are stoc, dar nu s-a vândut niciodată" },
  blocat: { label: "Blocat", cls: "status-progress", hint: "nicio vânzare de peste 30 de zile" },
  critic: { label: "Se termină", cls: "status-cancelled", hint: "stoc pentru mai puțin de 14 zile" },
  lent: { label: "Lent", cls: "status-progress", hint: "stoc pentru peste 180 de zile" },
  ok: { label: "OK", cls: "status-finalized", hint: "" },
  epuizat: { label: "Epuizat", cls: "status-cancelled", hint: "s-a vândut, acum stoc 0" },
  "fara-stoc": { label: "Fără stoc", cls: "", hint: "" },
};

let data = null;
let preset = "30";
let stockFilter = "cu-stoc";
const sortState = {
  products: { key: "revenue", dir: -1 },
  stock: { key: "value", dir: -1 },
};

/* ---------------- utilitare ---------------- */

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

const fmt0 = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt1 = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 1 });

function lei(n, { decimals } = {}) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const f = decimals === 2 || (decimals == null && Math.abs(v) < 100) ? fmt2 : fmt0;
  return `${f.format(v)} lei`;
}

function pct(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `${fmt1.format(Number(n))}%`;
}

function num(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return fmt1.format(Number(n));
}

function signedClass(n) {
  return n != null && Number(n) < 0 ? "is-neg" : "";
}

function dayLabel(day, withYear = false) {
  if (!day) return "—";
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
}

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ preset, from: elFrom.value, to: elTo.value, platform: elPlatform.value })
    );
  } catch {
    /* ignore */
  }
}

/* ---------------- tooltip ---------------- */

function showTip(evt, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const pad = 12;
  const rect = tooltip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY - rect.height - pad;
  if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
  if (y < 8) y = evt.clientY + pad;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${y}px`;
}

function hideTip() {
  tooltip.hidden = true;
}

function bindTips(root) {
  root.querySelectorAll("[data-tip]").forEach((node) => {
    node.addEventListener("pointermove", (e) => showTip(e, node.getAttribute("data-tip")));
    node.addEventListener("pointerleave", hideTip);
  });
}

/* ---------------- grafice SVG ---------------- */

function niceStep(range, target) {
  const raw = range / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/** Bara cu capatul de date rotunjit (4px) si baza dreapta. */
function barPath(x, w, yBase, yEnd) {
  const h = Math.abs(yEnd - yBase);
  const r = Math.min(4, w / 2, h);
  if (h < 0.5) return "";
  if (yEnd < yBase) {
    return `M${x},${yBase}V${yEnd + r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd + r}V${yBase}Z`;
  }
  return `M${x},${yBase}V${yEnd - r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd - r}V${yBase}Z`;
}

/**
 * Coloane cu o singura serie. Valorile negative coboara sub zero in culoarea de pierdere.
 * items: [{ label, value, tip }]
 */
function columnChart(el, items, { height = 220, format = (v) => v, labelEvery, integer = false } = {}) {
  const width = Math.max(260, el.clientWidth || 600);
  const m = { top: 12, right: 8, bottom: 26, left: 56 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;
  if (!items.length) {
    el.innerHTML = `<p class="stats-empty">Nicio dată în perioadă.</p>`;
    return;
  }
  const vals = items.map((d) => d.value || 0);
  let max = Math.max(0, ...vals);
  let min = Math.min(0, ...vals);
  if (max === min) max = 1;
  const step = integer ? Math.max(1, niceStep(max - min, 4)) : niceStep(max - min, 4);
  max = Math.ceil(max / step) * step;
  min = Math.floor(min / step) * step;
  const y = (v) => m.top + ((max - v) / (max - min)) * ih;
  const band = iw / items.length;
  const bw = Math.max(2, Math.min(24, band * 0.7));
  const every = labelEvery || Math.max(1, Math.ceil(items.length / Math.max(2, Math.floor(iw / 64))));

  let grid = "";
  for (let v = min; v <= max + step / 2; v += step) {
    const yy = y(v);
    grid += `<line class="viz-grid${Math.abs(v) < step / 1e6 ? " viz-zero" : ""}" x1="${m.left}" x2="${width - m.right}" y1="${yy}" y2="${yy}"/>`;
    grid += `<text class="viz-tick" x="${m.left - 8}" y="${yy + 4}" text-anchor="end">${escapeHtml(format(v, true))}</text>`;
  }
  let bars = "";
  let labels = "";
  items.forEach((d, i) => {
    const x = m.left + i * band + (band - bw) / 2;
    const v = d.value || 0;
    const path = barPath(x, bw, y(0), y(v));
    if (path) bars += `<path class="${v < 0 ? "viz-neg" : "viz-pos"}" d="${path}"/>`;
    bars += `<rect class="viz-hit" x="${m.left + i * band}" y="${m.top}" width="${band}" height="${ih}" data-tip="${escapeHtml(d.tip)}"/>`;
    if (i % every === 0) {
      labels += `<text class="viz-tick" x="${m.left + i * band + band / 2}" y="${height - 8}" text-anchor="middle">${escapeHtml(d.label)}</text>`;
    }
  });
  el.innerHTML = `<svg class="viz" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">${grid}${bars}${labels}</svg>`;
  bindTips(el);
}

/** Bare orizontale cu eticheta si valoarea scrise (fara legenda). */
function barList(el, rows, { format = num } = {}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value || 0)));
  el.innerHTML = rows.length
    ? `<div class="viz-barlist">${rows
        .map(
          (r) => `<div class="viz-barrow" data-tip="${escapeHtml(r.tip || `${r.label}: ${format(r.value)}`)}">
            <span class="viz-barlabel">${escapeHtml(r.label)}</span>
            <span class="viz-bartrack"><span class="viz-barfill ${r.value < 0 || r.neg ? "is-neg" : ""}" style="width:${(Math.abs(r.value || 0) / max) * 100}%"></span></span>
            <span class="viz-barvalue ${r.value < 0 ? "is-neg" : ""}">${escapeHtml(r.display ?? format(r.value))}</span>
          </div>`
        )
        .join("")}</div>`
    : `<p class="stats-empty">Nicio dată în perioadă.</p>`;
  bindTips(el);
}

/* ---------------- tabele sortabile ---------------- */

function renderTable(el, { columns, rows, sortKey, empty = "Nimic de afișat.", rowClass }) {
  if (!rows.length) {
    el.innerHTML = `<p class="stats-empty">${escapeHtml(empty)}</p>`;
    return;
  }
  const st = sortKey ? sortState[sortKey] : null;
  let sorted = rows;
  if (st) {
    const col = columns.find((c) => c.key === st.key);
    const val = col?.sort || ((r) => r[st.key]);
    sorted = [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return va.localeCompare(vb, "ro") * st.dir;
      return (va - vb) * st.dir;
    });
  }
  const head = columns
    .map((c) => {
      const active = st && st.key === c.key;
      const arrow = active ? (st.dir < 0 ? " ▾" : " ▴") : "";
      const sortable = st && c.sortable !== false;
      return `<th class="${c.num ? "is-num" : ""}${sortable ? " is-sortable" : ""}" ${sortable ? `data-sort="${c.key}"` : ""} ${c.title ? `title="${escapeHtml(c.title)}"` : ""} ${active ? `aria-sort="${st.dir < 0 ? "descending" : "ascending"}"` : ""}>${escapeHtml(c.label)}${arrow}</th>`;
    })
    .join("");
  const body = sorted
    .map(
      (r) =>
        `<tr class="${rowClass ? rowClass(r) : ""}">${columns
          .map((c) => `<td class="${c.num ? "is-num" : ""} ${c.cls ? c.cls(r) : ""}">${c.html ? c.html(r) : escapeHtml(c.fmt ? c.fmt(r[c.key], r) : r[c.key] ?? "—")}</td>`)
          .join("")}</tr>`
    )
    .join("");
  el.innerHTML = `<table class="stats-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  if (st) {
    el.querySelectorAll("th[data-sort]").forEach((th) =>
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (st.key === key) st.dir *= -1;
        else {
          st.key = key;
          st.dir = columns.find((c) => c.key === key)?.num ? -1 : 1;
        }
        renderTable(el, { columns, rows, sortKey, empty, rowClass });
      })
    );
  }
}

function productCell(r) {
  const code = r.code ? `<span class="stats-code">${escapeHtml(r.code)}</span>` : "";
  return `<span class="stats-prod" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>${code}`;
}

/* ---------------- sectiuni ---------------- */

function renderAlerts() {
  const { meta, kpis, stock } = data;
  const alerts = [];
  if (meta.daysSinceLastOrder != null && meta.daysSinceLastOrder >= 5) {
    alerts.push({
      kind: "warn",
      text: `Nicio comandă de <b>${meta.daysSinceLastOrder} zile</b> (ultima: ${dayLabel(meta.lastOrderDay, true)}). Verifică dacă ofertele sunt active și prețurile competitive.`,
    });
  }
  if (kpis.orders > 0 && kpis.lossOrders > 0) {
    alerts.push({
      kind: kpis.lossOrders / kpis.orders >= 0.3 ? "bad" : "warn",
      text: `<b>${kpis.lossOrders} din ${kpis.orders}</b> comenzi din perioadă au adus pierdere după comision, curier și consumabile. Vezi „Comenzi în pierdere”.`,
    });
  }
  const below = stock.items.filter((i) => i.belowBreakEven);
  if (below.length) {
    alerts.push({
      kind: "bad",
      text: `<b>${below.length} produse</b> au acum prețul sub pragul fără pierdere (o bucată, livrare gratuită). Filtrează stocul pe „Sub prag”.`,
    });
  }
  const idle = stock.items.filter((i) => i.state === "nevandut" || i.state === "blocat");
  const idleValue = idle.reduce((s, i) => s + (i.value || 0), 0);
  if (idle.length) {
    alerts.push({
      kind: "info",
      text: `<b>${lei(idleValue)}</b> stau în ${idle.length} produse care nu s-au vândut deloc sau nu s-au mai vândut de 30 de zile.`,
    });
  }
  document.getElementById("stats-alerts").innerHTML = alerts
    .map((a) => `<div class="stats-alert is-${a.kind}"><span class="stats-alert-icon" aria-hidden="true">${a.kind === "info" ? "i" : "!"}</span><span>${a.text}</span></div>`)
    .join("");
}

function delta(cur, prev, { goodUp = true, kind = "rel" } = {}) {
  if (prev == null || cur == null || !Number.isFinite(prev) || !Number.isFinite(cur)) return "";
  let diff;
  let text;
  if (kind === "pp") {
    diff = cur - prev;
    if (Math.abs(diff) < 0.05) return `<span class="kpi-delta">la fel</span>`;
    text = `${diff > 0 ? "+" : "−"}${fmt1.format(Math.abs(diff))} pp`;
  } else {
    if (prev === 0) return "";
    diff = cur - prev;
    if (Math.abs(diff) < 1e-9) return `<span class="kpi-delta">la fel</span>`;
    text = `${diff > 0 ? "+" : "−"}${fmt0.format(Math.abs((diff / Math.abs(prev)) * 100))}%`;
  }
  const good = diff > 0 === goodUp;
  return `<span class="kpi-delta ${good ? "is-good" : "is-bad"}">${diff > 0 ? "▲" : "▼"} ${text}</span>`;
}

function kpiTile({ label, value, sub, deltaHtml, hero, negative, title }) {
  return `<div class="kpi${hero ? " kpi-hero" : ""}" ${title ? `title="${escapeHtml(title)}"` : ""}>
    <div class="kpi-label">${escapeHtml(label)}</div>
    <div class="kpi-value ${negative ? "is-neg" : ""}">${value}</div>
    <div class="kpi-sub">${deltaHtml || ""}${sub ? `<span>${sub}</span>` : ""}</div>
  </div>`;
}

function renderKpis() {
  const { kpis: k, previous: p, meta } = data;
  const hasPrev = p.orders + p.returned > 0;
  const d = (cur, prev, opts) => (hasPrev ? delta(cur, prev, opts) : "");
  const span = daysBetween(meta.from, meta.to) + 1;
  document.getElementById("kpi-period").textContent =
    `${dayLabel(meta.from, true)} – ${dayLabel(meta.to, true)} (${span} zile)` +
    (meta.platform ? ` · ${PLATFORM_LABELS[meta.platform]}` : "") +
    (hasPrev ? ` · comparat cu ${dayLabel(meta.prevFrom)} – ${dayLabel(meta.prevTo)}` : "");

  document.getElementById("stats-kpis").innerHTML = [
    kpiTile({
      label: "Profit net estimat",
      value: lei(k.net),
      hero: true,
      negative: k.net < 0,
      deltaHtml: d(k.net, p.net),
      sub: k.incomplete ? `${k.incomplete} comenzi fără preț de cumpărare, excluse` : "după comision, curier, consumabile și impozit",
    }),
    kpiTile({ label: "Încasări produse", value: lei(k.revenue), deltaHtml: d(k.revenue, p.revenue), sub: `+ ${lei(k.shipping)} transport plătit de clienți` }),
    kpiTile({ label: "Comenzi", value: fmt0.format(k.orders), deltaHtml: d(k.orders, p.orders), sub: `${fmt0.format(k.units)} bucăți` }),
    kpiTile({ label: "Valoare medie comandă", value: lei(k.aov), deltaHtml: d(k.aov, p.aov) }),
    kpiTile({
      label: "Profit net pe comandă",
      value: lei(k.netPerOrder),
      negative: k.netPerOrder < 0,
      deltaHtml: d(k.netPerOrder, p.netPerOrder),
    }),
    kpiTile({ label: "Marjă netă", value: pct(k.margin), negative: k.margin < 0, deltaHtml: d(k.margin, p.margin, { kind: "pp" }), sub: "din încasările pe produse" }),
    kpiTile({
      label: "Profit brut produse",
      value: lei(k.gross),
      negative: k.gross < 0,
      deltaHtml: d(k.gross, p.gross),
      sub: "ca în pagina Comenzi: preț − comision − cost",
    }),
    kpiTile({
      label: "Retururi",
      value: pct(k.returnRate),
      deltaHtml: d(k.returnRate, p.returnRate, { goodUp: false, kind: "pp" }),
      sub: `${k.returned} comenzi · ~${lei(k.returnCost)} pierduți pe curier și ambalaj`,
    }),
    kpiTile({
      label: "Comenzi în pierdere",
      value: fmt0.format(k.lossOrders),
      negative: k.lossOrders > 0,
      deltaHtml: d(k.lossOrders, p.lossOrders, { goodUp: false }),
      sub: k.orders ? `${pct((k.lossOrders / k.orders) * 100)} din comenzi` : "",
    }),
    kpiTile({ label: "Anulate", value: fmt0.format(k.cancelled), sub: "nu intră în încasări" }),
  ].join("");
}

function renderFlow() {
  const k = data.kpis;
  const el = document.getElementById("stats-flow");
  if (!k.orders) {
    el.innerHTML = `<p class="stats-empty">Nicio comandă în perioadă.</p>`;
    return;
  }
  const taxBack = k.tax < 0;
  const rows = [
    { label: "Încasări produse", value: k.revenue },
    { label: "Transport plătit de clienți", value: k.shipping },
    { label: "Cost produse (preț cumpărare)", value: -k.cost },
    { label: "Comision eMAG + TVA", value: -k.commission },
    { label: "Curier + consumabile", value: -k.fixedCosts },
    { label: taxBack ? "Impozit (pierderea îl reduce)" : "Impozit pe profit", value: -k.tax },
  ];
  barList(el, [
    ...rows.map((r) => ({
      label: r.label,
      value: r.value,
      display: `${r.value >= 0 ? "+" : "−"}${lei(Math.abs(r.value))}`,
    })),
    { label: "= Profit net estimat", value: k.net, display: lei(k.net) },
  ]);
  el.querySelector(".viz-barrow:last-child")?.classList.add("is-total");
}

function renderPlatforms() {
  const rows = data.platforms.filter((p) => p.orders + p.returned + p.cancelled > 0);
  renderTable(document.getElementById("stats-platforms"), {
    rows,
    empty: "Nicio comandă în perioadă.",
    columns: [
      { key: "platform", label: "Țară", fmt: (v) => PLATFORM_LABELS[v] || v },
      { key: "orders", label: "Comenzi", num: true },
      { key: "revenue", label: "Încasări", num: true, fmt: (v) => lei(v) },
      { key: "net", label: "Profit net", num: true, fmt: (v) => lei(v), cls: (r) => signedClass(r.net) },
      { key: "margin", label: "Marjă", num: true, fmt: pct, cls: (r) => signedClass(r.margin) },
      { key: "returnRate", label: "Retur", num: true, fmt: pct },
    ],
  });
}

/** Seria zilnica sau pe saptamani (de luni), dupa lungimea perioadei. */
function bucketSeries() {
  const s = data.series;
  if (s.length <= WEEK_BUCKET_AFTER_DAYS) {
    return {
      unit: "pe zi",
      items: s.map((d) => ({ ...d, label: dayLabel(d.day), title: dayLabel(d.day, true) })),
    };
  }
  const weeks = [];
  let cur = null;
  for (const d of s) {
    const dow = (new Date(`${d.day}T12:00:00Z`).getUTCDay() + 6) % 7;
    if (!cur || dow === 0) {
      cur = { day: d.day, end: d.day, orders: 0, revenue: 0, net: 0, returned: 0 };
      weeks.push(cur);
    }
    cur.end = d.day;
    cur.orders += d.orders;
    cur.revenue += d.revenue;
    cur.net += d.net;
    cur.returned += d.returned;
  }
  return {
    unit: "pe săptămână",
    items: weeks.map((w) => ({ ...w, label: dayLabel(w.day), title: `${dayLabel(w.day)} – ${dayLabel(w.end, true)}` })),
  };
}

function compactLei(v, axis) {
  if (axis && Math.abs(v) >= 1000) return `${fmt1.format(v / 1000)}k`;
  return fmt0.format(v);
}

function renderSeries() {
  const { unit, items } = bucketSeries();
  document.getElementById("rev-bucket").textContent = unit;
  document.getElementById("net-bucket").textContent = unit;
  columnChart(
    document.getElementById("chart-revenue"),
    items.map((d) => ({
      label: d.label,
      value: d.revenue,
      tip: `<b>${d.title}</b><br>Încasări: ${lei(d.revenue)}<br>Comenzi: ${d.orders}${d.returned ? `<br>Returnate: ${d.returned}` : ""}`,
    })),
    { format: compactLei }
  );
  columnChart(
    document.getElementById("chart-net"),
    items.map((d) => ({
      label: d.label,
      value: d.net,
      tip: `<b>${d.title}</b><br>Profit net: ${lei(d.net)}<br>Comenzi: ${d.orders}`,
    })),
    { format: compactLei }
  );
  renderTable(document.getElementById("series-table"), {
    rows: items.filter((d) => d.orders || d.returned),
    empty: "Nicio comandă în perioadă.",
    columns: [
      { key: "title", label: unit === "pe zi" ? "Zi" : "Săptămână" },
      { key: "orders", label: "Comenzi", num: true },
      { key: "returned", label: "Returnate", num: true },
      { key: "revenue", label: "Încasări", num: true, fmt: (v) => lei(v) },
      { key: "net", label: "Profit net", num: true, fmt: (v) => lei(v), cls: (r) => signedClass(r.net) },
    ],
  });
}

function renderPatterns() {
  const total = data.weekday.reduce((a, b) => a + b, 0);
  columnChart(
    document.getElementById("chart-weekday"),
    data.weekday.map((v, i) => ({
      label: WEEKDAYS[i],
      value: v,
      tip: `<b>${WEEKDAYS[i]}</b><br>${v} comenzi${total ? ` (${pct((v / total) * 100)})` : ""}`,
    })),
    { height: 180, format: (v) => fmt0.format(v), labelEvery: 1, integer: true }
  );
  columnChart(
    document.getElementById("chart-hours"),
    data.hours.map((v, h) => ({
      label: `${h}`,
      value: v,
      tip: `<b>${String(h).padStart(2, "0")}:00 – ${String(h).padStart(2, "0")}:59</b><br>${v} comenzi`,
    })),
    { height: 180, format: (v) => fmt0.format(v), labelEvery: 3, integer: true }
  );
  const payTotal = data.payments.reduce((s, p) => s + p.count, 0);
  barList(
    document.getElementById("stats-payments"),
    data.payments.map((p) => ({
      label: p.mode === "RAMBURS" ? "Ramburs" : p.mode === "CARD online" ? "Card online" : p.mode,
      value: p.count,
      display: `${p.count} (${pct((p.count / payTotal) * 100)})`,
    }))
  );
}

function renderProducts() {
  renderTable(document.getElementById("stats-products"), {
    rows: data.products,
    sortKey: "products",
    empty: "Niciun produs vândut în perioadă.",
    columns: [
      { key: "name", label: "Produs", html: productCell, sort: (r) => r.name },
      { key: "units", label: "Buc.", num: true },
      { key: "orders", label: "Comenzi", num: true },
      { key: "revenue", label: "Încasări", num: true, fmt: (v) => lei(v) },
      { key: "gross", label: "Profit brut", num: true, fmt: (v) => lei(v), cls: (r) => signedClass(r.gross), title: "Preț după comision minus prețul de cumpărare" },
      { key: "net", label: "Profit net", num: true, fmt: (v) => lei(v), cls: (r) => signedClass(r.net), title: "După curier, consumabile și impozit" },
      { key: "netPerUnit", label: "Net / buc.", num: true, fmt: (v) => lei(v), cls: (r) => signedClass(r.netPerUnit) },
      { key: "margin", label: "Marjă", num: true, fmt: pct, cls: (r) => signedClass(r.margin) },
      { key: "pct", label: "Comision", num: true, fmt: (v, r) => `${pct(v)}${r.pctDefault ? "*" : ""}` },
      { key: "returnedUnits", label: "Returnate", num: true },
      { key: "returnRate", label: "Retur %", num: true, fmt: pct },
    ],
  });
}

function renderLoss() {
  renderTable(document.getElementById("stats-loss"), {
    rows: data.lossOrders,
    empty: "Nicio comandă în pierdere în perioadă.",
    columns: [
      { key: "id", label: "Comandă" },
      { key: "day", label: "Data", fmt: (v) => dayLabel(v, true) },
      { key: "platform", label: "Țară", fmt: (v) => v.toUpperCase() },
      { key: "products", label: "Produse", html: (r) => `<span class="stats-prod" title="${escapeHtml(r.products.join(", "))}">${escapeHtml(r.products.join(", "))}</span>` },
      { key: "revenue", label: "Încasat", num: true, fmt: (v) => lei(v) },
      { key: "shipping", label: "Transport client", num: true, fmt: (v) => lei(v) },
      { key: "cost", label: "Cost produse", num: true, fmt: (v) => lei(v) },
      { key: "commission", label: "Comision + TVA", num: true, fmt: (v) => lei(v) },
      { key: "fixedCosts", label: "Curier + ambalaj", num: true, fmt: (v) => lei(v) },
      { key: "net", label: "Profit net", num: true, fmt: (v) => lei(v), cls: () => "is-neg" },
    ],
  });
}

const STOCK_FILTERS = [
  { key: "cu-stoc", label: "Cu stoc", test: (i) => i.stock > 0 },
  { key: "nevandut", label: "Nevândute", test: (i) => i.state === "nevandut" },
  { key: "blocat", label: "Blocate", test: (i) => i.state === "blocat" },
  { key: "critic", label: "Se termină", test: (i) => i.state === "critic" },
  { key: "lent", label: "Lente", test: (i) => i.state === "lent" },
  { key: "epuizat", label: "Epuizate", test: (i) => i.state === "epuizat" },
  { key: "sub-prag", label: "Sub prag preț", test: (i) => i.belowBreakEven },
  { key: "toate", label: "Toate", test: () => true },
];

function renderStock() {
  const { items, windowDays } = data.stock;
  const withStock = items.filter((i) => i.stock > 0);
  const value = withStock.reduce((s, i) => s + (i.value || 0), 0);
  const idle = items.filter((i) => i.state === "nevandut" || i.state === "blocat");
  const idleValue = idle.reduce((s, i) => s + (i.value || 0), 0);
  const critical = items.filter((i) => i.state === "critic");
  const out = items.filter((i) => i.state === "epuizat");
  const below = items.filter((i) => i.belowBreakEven);

  document.getElementById("stock-kpis").innerHTML = [
    kpiTile({ label: "Valoare stoc (preț cumpărare)", value: lei(value), sub: `${withStock.length} produse, ${fmt0.format(withStock.reduce((s, i) => s + i.stock, 0))} bucăți` }),
    kpiTile({
      label: "Bani blocați în stoc care nu se vinde",
      value: lei(idleValue),
      negative: idleValue > 0,
      sub: value ? `${pct((idleValue / value) * 100)} din stoc · ${idle.length} produse` : "",
    }),
    kpiTile({ label: "Se termină în < 14 zile", value: fmt0.format(critical.length), sub: critical.length ? critical.map((i) => i.code || i.name).slice(0, 3).join(", ") : "nimic urgent" }),
    kpiTile({ label: "Epuizate (s-au vândut)", value: fmt0.format(out.length), sub: out.length ? out.map((i) => i.code || i.name).slice(0, 3).join(", ") : "" }),
    kpiTile({ label: "Preț sub prag fără pierdere", value: fmt0.format(below.length), negative: below.length > 0, sub: "o bucată, livrare gratuită" }),
  ].join("");

  const filtersEl = document.getElementById("stock-filters");
  filtersEl.innerHTML = STOCK_FILTERS.map((f) => {
    const n = items.filter(f.test).length;
    return `<button type="button" class="stats-chip${stockFilter === f.key ? " is-active" : ""}" data-filter="${f.key}" aria-pressed="${stockFilter === f.key}">${escapeHtml(f.label)} <span class="stats-chip-count">${n}</span></button>`;
  }).join("");
  filtersEl.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      stockFilter = b.dataset.filter;
      renderStock();
    })
  );

  document.getElementById("stock-note").textContent =
    `Ritmul de vânzare e media ultimelor ${windowDays} zile, pe toate țările. „Prag fără pierdere” = prețul minim la care o comandă cu o bucată nu pierde bani când clientul nu plătește transportul.`;

  const filter = STOCK_FILTERS.find((f) => f.key === stockFilter) || STOCK_FILTERS[0];
  renderTable(document.getElementById("stats-stock"), {
    rows: items.filter(filter.test),
    sortKey: "stock",
    empty: "Niciun produs în această categorie.",
    columns: [
      { key: "name", label: "Produs", html: productCell, sort: (r) => r.name },
      { key: "stock", label: "Stoc", num: true, fmt: num },
      { key: "value", label: "Valoare", num: true, fmt: (v) => lei(v) },
      { key: "soldAll", label: "Vândute total", num: true, fmt: num },
      { key: "sold30", label: "Ultimele 30 z", num: true, fmt: num },
      { key: "perWeek", label: "Pe săpt.", num: true, fmt: num },
      { key: "daysLeft", label: "Zile rămase", num: true, fmt: (v) => (v == null ? "—" : fmt0.format(v)) },
      { key: "lastSale", label: "Ultima vânzare", fmt: (v, r) => (v ? `${dayLabel(v)} (${r.sinceLast} z)` : "niciodată"), sort: (r) => r.lastSale || "" },
      { key: "price", label: "Preț acum", num: true, fmt: (v) => lei(v) },
      { key: "breakEven", label: "Prag fără pierdere", num: true, fmt: (v) => lei(v), cls: (r) => (r.belowBreakEven ? "is-neg" : "") },
      {
        key: "state",
        label: "Stare",
        html: (r) => {
          const s = STOCK_STATES[r.state] || { label: r.state, cls: "" };
          const extra = r.belowBreakEven ? ` <span class="status-badge status-cancelled" title="Prețul actual e sub pragul fără pierdere">Sub prag</span>` : "";
          return `<span class="status-badge ${s.cls}" title="${escapeHtml(s.hint)}">${escapeHtml(s.label)}</span>${extra}`;
        },
        sort: (r) => r.state,
      },
    ],
  });
}

function priceVerdict(e) {
  if (e.afterDays < 7) return { text: e.cutByNext ? "Prețul s-a schimbat iar" : "Prea devreme", cls: "" };
  if (!e.beforeUnits && !e.afterUnits) return { text: "Fără vânzări", cls: "" };
  const b = e.beforePerWeek || 0;
  const a = e.afterPerWeek || 0;
  if (a > b * 1.25 + 0.1) return { text: "Vânzări în creștere", cls: "status-finalized" };
  if (a < b * 0.75 - 0.1) return { text: "Vânzări în scădere", cls: "status-cancelled" };
  return { text: "Fără schimbare clară", cls: "status-progress" };
}

function renderPrices() {
  renderTable(document.getElementById("stats-prices"), {
    rows: data.prices,
    empty: "Nicio schimbare de preț înregistrată.",
    columns: [
      { key: "name", label: "Produs", html: productCell },
      { key: "day", label: "Data", fmt: (v) => dayLabel(v, true) },
      { key: "from", label: "Preț", num: true, html: (r) => `${escapeHtml(lei(r.from, { decimals: 2 }))} → <b>${escapeHtml(lei(r.to, { decimals: 2 }))}</b>` },
      { key: "changePct", label: "Schimbare", num: true, fmt: (v) => `${v > 0 ? "+" : ""}${pct(v)}` },
      { key: "beforePerWeek", label: "Înainte / săpt.", num: true, fmt: (v, r) => `${num(v)} (${r.beforeUnits} buc, ${r.beforeDays} z)` },
      { key: "afterPerWeek", label: "După / săpt.", num: true, fmt: (v, r) => `${num(v)} (${r.afterUnits} buc, ${r.afterDays} z)` },
      {
        key: "verdict",
        label: "Concluzie",
        html: (r) => {
          const v = priceVerdict(r);
          return `<span class="status-badge ${v.cls}">${escapeHtml(v.text)}</span>`;
        },
      },
    ],
  });
}

function renderMethod() {
  const { meta } = data;
  const p = meta.params;
  const regimLabel = {
    profit_neplatitor: "impozit pe profit, neplătitor de TVA",
    profit_platitor: "impozit pe profit, plătitor de TVA",
    micro_neplatitor: "microîntreprindere, neplătitor de TVA",
    micro_platitor: "microîntreprindere, plătitor de TVA",
  }[p.regim] || p.regim;
  document.getElementById("stats-method").innerHTML = `
    <ul class="stats-method-list">
      <li><b>Profit net estimat</b> = încasări produse + transport plătit de client − cost produse − comision eMAG (și pe transport) − TVA pe comision − curier ${lei(p.curierat_contract, { decimals: 2 })} − consumabile ${lei(p.consumabile, { decimals: 2 })} pe colet − impozit ${pct(p.impozit)}. Aceleași formule ca în calculator (${escapeHtml(regimLabel)}). Parametrii se schimbă din <a href="/settings.html">Setări</a>.</li>
      <li><b>Profit brut</b> = preț vânzare − comision − preț cumpărare, adică formula din pagina Comenzi (fără curier, ambalaj și impozit).</li>
      <li>Comisionul e cel salvat pe fiecare ofertă; unde lipsește se folosește ${pct(p.defaultPct)} (marcat cu *).</li>
      <li>Comenzile anulate și cele returnate nu intră în încasări și profit. Pentru retururi se estimează ca pierdere curierul și ambalajul.</li>
      <li>Prețul de cumpărare e cel de acum din catalog, nu cel de la data comenzii.</li>
      <li>Curs: 1 EUR = ${escapeHtml(String(meta.rates.EUR).replace(".", ","))} lei, 100 HUF = ${escapeHtml(fmt2.format(meta.rates.HUF * 100))} lei (${escapeHtml(meta.rates.source)}${meta.rates.date ? `, ${escapeHtml(dayLabel(meta.rates.date, true))}` : ""}).</li>
      <li>Datele încep pe ${escapeHtml(dayLabel(meta.dataStart, true))} (prima comandă salvată local). Comenzile Trendyol nu sunt încă incluse.</li>
    </ul>`;
}

function renderAll() {
  if (!data) return;
  renderAlerts();
  renderKpis();
  renderFlow();
  renderPlatforms();
  renderSeries();
  renderPatterns();
  renderProducts();
  renderLoss();
  renderStock();
  renderPrices();
  renderMethod();
}

/* ---------------- incarcare ---------------- */

function applyPreset(p) {
  preset = p;
  const today = todayLocal();
  if (p === "all") {
    elFrom.value = data?.meta?.dataStart || "2026-01-01";
    elTo.value = today;
  } else if (p !== "custom") {
    elTo.value = today;
    elFrom.value = addDays(today, -(Number(p) - 1));
  }
  document.querySelectorAll(".stats-presets [data-days]").forEach((b) => {
    const on = b.dataset.days === p;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

async function load() {
  if (elFrom.value && elTo.value && elFrom.value > elTo.value) {
    setStatus("„De la” trebuie să fie înainte de „Până la”.", "error");
    return;
  }
  setStatus("Se încarcă…", "loading");
  elReload.disabled = true;
  try {
    const params = new URLSearchParams();
    if (elFrom.value) params.set("from", elFrom.value);
    if (elTo.value) params.set("to", elTo.value);
    if (elPlatform.value) params.set("platform", elPlatform.value);
    const res = await fetch(`/api/stats?${params}`);
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw new Error(json?.error || `Eroare ${res.status}`);
    data = json;
    // "Tot" are nevoie de data primei comenzi, pe care o aflam abia acum.
    if (preset === "all" && elFrom.value !== data.meta.dataStart) {
      elFrom.value = data.meta.dataStart;
      return load();
    }
    savePrefs();
    renderAll();
    setStatus(`Actualizat ${new Date().toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" })}`, "ok");
  } catch (err) {
    setStatus(err.message || "Eroare la încărcare", "error");
  } finally {
    elReload.disabled = false;
  }
}

document.querySelectorAll(".stats-presets [data-days]").forEach((b) =>
  b.addEventListener("click", () => {
    applyPreset(b.dataset.days);
    load();
  })
);
[elFrom, elTo].forEach((input) =>
  input.addEventListener("change", () => {
    applyPreset("custom");
    load();
  })
);
elPlatform.addEventListener("change", load);
elReload.addEventListener("click", load);

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!data) return;
    renderSeries();
    renderPatterns();
  }, 150);
});
document.querySelector(".stats-page").addEventListener("scroll", hideTip, { passive: true });

(function init() {
  const prefs = readPrefs();
  if (prefs.platform && PLATFORM_LABELS[prefs.platform]) elPlatform.value = prefs.platform;
  if (prefs.preset === "custom" && prefs.from && prefs.to) {
    elFrom.value = prefs.from;
    elTo.value = prefs.to;
    applyPreset("custom");
  } else {
    applyPreset(["7", "30", "90", "all"].includes(prefs.preset) ? prefs.preset : "30");
  }
  load();
})();
