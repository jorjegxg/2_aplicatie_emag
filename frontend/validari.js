const elTable = document.getElementById("val-table");
const elEvents = document.getElementById("val-events");
const elCount = document.getElementById("val-count");
const elRun = document.getElementById("val-run");
const elStatus = document.getElementById("val-status");
const elRefresh = document.getElementById("val-refresh");

const PLATFORMS = ["ro", "hu", "bg"];
const LABEL = { ro: "RO", hu: "HU", bg: "BG" };
const SITE = { ro: "www.emag.ro", hu: "www.emag.hu", bg: "www.emag.bg" };
const GROUP_CLS = {
  validare: "status-progress",
  validat: "status-finalized",
  blocat: "status-returned",
  respins: "status-cancelled",
  altul: "status-returned",
  lipsa: "",
};
const ACTION_CLS = { asteapta: "status-progress", pune: "status-new", repara: "status-cancelled", verifica: "status-returned" };
const PREFS_KEY = "emag-validari-filter-v1";

let data = null;
let filter = localStorage.getItem(PREFS_KEY) || "actiune";

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

function when(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ro-RO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** „de 3 h”, „de 2 zile” – cât stă pe statusul curent. */
function age(iso) {
  if (!iso) return "";
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} zile`;
}

function platformCell(p, s) {
  if (!s) return `<span class="status-badge" title="Nicio ofertă pe ${LABEL[p]}">lipsă</span>`;
  const errs = s.errors && s.errors.length ? ` · ${s.errors.join(", ")}` : "";
  const title = `${s.status_text || ""} (status ${s.status})${errs} · oferta ${s.offer_id} · din ${when(s.since)}`;
  return `<span class="status-badge ${GROUP_CLS[s.grp] || ""}" title="${escapeHtml(title)}">${escapeHtml(s.grp_text)} ${s.status}</span> <span class="muted">${age(s.since)}</span>`;
}

function visible(item) {
  if (filter === "toate") return true;
  if (filter === "validare") return PLATFORMS.some((p) => item.platforms[p] && item.platforms[p].grp === "validare");
  return item.next.action !== "gata" && item.next.action !== "asteapta";
}

/** Întâi ce poți face acum, apoi ce așteaptă; în rest după id. */
function rank(item) {
  return { pune: 0, repara: 1, verifica: 2, asteapta: 3, gata: 4 }[item.next.action] ?? 5;
}

function renderTable() {
  const items = data.items.filter(visible).sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  elCount.textContent = `${items.length} din ${data.items.length}`;
  if (!items.length) {
    elTable.innerHTML = `<p class="muted">Nimic aici.</p>`;
    return;
  }
  const head = ["#", "Cod", "Produs", ...PLATFORMS.map((p) => LABEL[p]), "Pasul următor"].map((h) => `<th>${h}</th>`).join("");
  const body = items
    .map((it) => {
      const pnk = it.pnk
        ? ` <a href="https://${SITE.ro}/-/pd/${encodeURIComponent(it.pnk)}" target="_blank" rel="noopener" class="muted">PNK</a>`
        : "";
      const name = String(it.nume || "").slice(0, 60);
      const next = it.next.action === "gata" ? "—" : `<span class="status-badge ${ACTION_CLS[it.next.action] || ""}">${escapeHtml(it.next.text)}</span>`;
      return `<tr>
        <td class="is-num">${it.id}</td>
        <td>${escapeHtml(it.cod_produs)}${pnk}</td>
        <td title="${escapeHtml(it.nume)}">${escapeHtml(name)}</td>
        ${PLATFORMS.map((p) => `<td>${platformCell(p, it.platforms[p])}</td>`).join("")}
        <td>${next}</td>
      </tr>`;
    })
    .join("");
  elTable.innerHTML = `<table class="stats-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderEvents() {
  if (!data.events.length) {
    elEvents.innerHTML = `<p class="muted">Încă nicio schimbare. Prima verificare doar salvează statusurile.</p>`;
    return;
  }
  const rows = data.events
    .map((e) => {
      const text = e.message || `${e.from_grp || "nou"} → ${e.to_grp}`;
      return `<tr>
        <td>${when(e.created_at)}</td>
        <td>${escapeHtml(e.cod_produs || "")}</td>
        <td>${LABEL[e.platform] || escapeHtml(e.platform)}</td>
        <td class="is-num">${e.from_status ?? "—"} → ${e.to_status ?? "—"}</td>
        <td>${escapeHtml(text)}${e.notified ? " 📨" : ""}</td>
      </tr>`;
    })
    .join("");
  elEvents.innerHTML = `<table class="stats-table"><thead><tr><th>Când</th><th>Cod</th><th>Țară</th><th>Status</th><th>Ce s-a întâmplat</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderRun() {
  const run = data.lastRun;
  const tg = data.telegram ? "Telegram activ" : "Telegram neconfigurat (pune TELEGRAM_BOT_TOKEN și TELEGRAM_CHAT_ID în .env)";
  if (!run) {
    elRun.textContent = `Încă nicio verificare. ${tg}.`;
    return;
  }
  const parts = PLATFORMS.map((p) => {
    const r = run.platforms && run.platforms[p];
    if (!r) return `${LABEL[p]} —`;
    return r.ok ? `${LABEL[p]} ${r.matched} oferte` : `${LABEL[p]} eroare: ${r.error}`;
  });
  elRun.textContent = `Ultima verificare: ${when(run.at)} · ${parts.join(" · ")} · ${tg}.`;
}

function render() {
  document.querySelectorAll(".stats-chip[data-filter]").forEach((b) => {
    const on = b.dataset.filter === filter;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  renderRun();
  renderTable();
  renderEvents();
}

async function load() {
  setStatus("Se încarcă…", "loading");
  try {
    const res = await fetch("/api/validari");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    data = json;
    render();
    setStatus("");
  } catch (e) {
    setStatus(e.message, "error");
  }
}

async function refresh() {
  elRefresh.disabled = true;
  setStatus("Citesc ofertele de pe eMAG RO/HU/BG…", "loading");
  try {
    const res = await fetch("/api/validari/refresh", { method: "POST" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    data = json;
    render();
    setStatus(json.events.length ? `${json.events.length} schimbări` : "Nicio schimbare", "ok");
  } catch (e) {
    setStatus(e.message, "error");
  } finally {
    elRefresh.disabled = false;
  }
}

document.querySelectorAll(".stats-chip[data-filter]").forEach((b) =>
  b.addEventListener("click", () => {
    filter = b.dataset.filter;
    localStorage.setItem(PREFS_KEY, filter);
    if (data) render();
  })
);
elRefresh.addEventListener("click", refresh);

load();
setInterval(load, 60_000);
