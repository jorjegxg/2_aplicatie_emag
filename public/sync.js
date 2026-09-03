/* Comparatie: valorile mele din DB vs ultimul snapshot al marketplace-ului. Doar citire. */

const CHANNEL_KEY = "marketplace-channel";

const channelSelect = document.getElementById("channel-select");
const btnReload = document.getElementById("btn-reload");
const btnPull = document.getElementById("btn-pull");
const onlyDiffToggle = document.getElementById("only-diff");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("sync-summary");
const diffHead = document.getElementById("diff-head");
const diffBody = document.getElementById("diff-body");
const onlyRemoteBody = document.getElementById("only-remote-body");
const onlyLocalBody = document.getElementById("only-local-body");
const unlinkedBody = document.getElementById("unlinked-body");

let currentChannel = localStorage.getItem(CHANNEL_KEY) || "emag";
let currentData = null;
let loading = false;
let pulling = false;

const STATUS_LABELS = { 0: "Inactiv", 1: "Activ", 2: "În așteptare" };

function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = "status";
  if (kind === "loading") statusEl.classList.add("is-loading");
  else if (kind === "error") statusEl.classList.add("is-error");
  else if (kind === "ok") statusEl.classList.add("is-ok");
}

function formatStamp(iso) {
  if (!iso) return "niciodată";
  try {
    return new Date(iso).toLocaleString("ro-RO");
  } catch {
    return String(iso);
  }
}

function formatValue(key, value) {
  if (value == null || value === "") return "—";
  if (key === "status") return STATUS_LABELS[Number(value)] ?? String(value);
  if (key === "name") return String(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return key === "general_stock" ? String(n) : n.toFixed(2);
}

function renderSummary(data) {
  const diffRows = data.matched.filter((m) => m.diff_count > 0).length;
  summaryEl.innerHTML = `
    <span class="sync-chip">Ultima preluare: <strong>${escapeHtml(formatStamp(data.last_sync))}</strong></span>
    <span class="sync-chip">Comune: <strong>${data.matched.length}</strong></span>
    <span class="sync-chip${diffRows ? " is-diff" : ""}">Cu diferențe: <strong>${diffRows}</strong></span>
    <span class="sync-chip">Doar pe marketplace: <strong>${data.only_remote.length}</strong></span>
    <span class="sync-chip">Doar local: <strong>${data.only_local.length}</strong></span>
    <span class="sync-chip">Nelegate: <strong>${data.unlinked.length}</strong></span>
  `;
}

function renderHead(fields) {
  diffHead.innerHTML = `
    <tr>
      <th rowspan="2">ID ofertă</th>
      <th rowspan="2">SKU</th>
      ${fields.map((f) => `<th colspan="2">${escapeHtml(f.label)}</th>`).join("")}
    </tr>
    <tr>
      ${fields
        .map(
          () =>
            `<th class="sync-sub sync-mine">Al meu</th><th class="sync-sub sync-theirs">Marketplace</th>`
        )
        .join("")}
    </tr>
  `;
}

function renderDiffRows(data) {
  const onlyDiff = onlyDiffToggle.checked;
  const rows = data.matched.filter((m) => !onlyDiff || m.diff_count > 0);
  const cols = data.fields.length * 2 + 2;

  if (rows.length === 0) {
    diffBody.innerHTML = `<tr class="empty-row"><td colspan="${cols}">${
      onlyDiff ? "Nicio diferență — DB-ul local e identic cu marketplace-ul." : "Niciun produs comun."
    }</td></tr>`;
    return;
  }

  diffBody.innerHTML = rows
    .map((row) => {
      const cells = row.fields
        .map(
          (f) =>
            `<td class="sync-mine${f.differs ? " is-diff" : ""}">${escapeHtml(
              formatValue(f.key, f.mine)
            )}</td><td class="sync-theirs${f.differs ? " is-diff" : ""}">${escapeHtml(
              formatValue(f.key, f.theirs)
            )}</td>`
        )
        .join("");
      return `<tr class="${row.diff_count > 0 ? "has-diff" : ""}">
        <td>${escapeHtml(row.external_id)}</td>
        <td>${escapeHtml(row.part_number || "—")}</td>
        ${cells}
      </tr>`;
    })
    .join("");
}

function renderSimpleRows(tbody, items, cols) {
  if (!items.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${cols}">—</td></tr>`;
    return;
  }
  tbody.innerHTML = items
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.external_id)}</td>
        <td>${escapeHtml(r.part_number || "—")}</td>
        <td>${escapeHtml(r.name || "—")}</td>
        ${cols > 3 ? `<td>${escapeHtml(formatValue("sale_price", r.sale_price))}</td>` : ""}
        ${cols > 3 ? `<td>${escapeHtml(formatValue("general_stock", r.general_stock))}</td>` : ""}
      </tr>`
    )
    .join("");
}

function render(data) {
  renderSummary(data);
  renderHead(data.fields);
  renderDiffRows(data);
  renderSimpleRows(onlyRemoteBody, data.only_remote, 5);
  renderSimpleRows(onlyLocalBody, data.only_local, 5);
  renderSimpleRows(unlinkedBody, data.unlinked, 3);
}

async function loadDiff() {
  if (loading) return;
  loading = true;
  btnReload.disabled = true;
  setStatus("Se compară…", "loading");
  try {
    const res = await fetch(`/api/sync/diff?channel=${encodeURIComponent(currentChannel)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    currentData = data;
    render(data);
    const diffRows = data.matched.filter((m) => m.diff_count > 0).length;
    if (!data.last_sync) {
      setStatus(
        `Nicio preluare de la ${currentChannel} încă — apasă „Preia de la marketplace".`,
        "error"
      );
    } else {
      setStatus(
        diffRows === 0
          ? "Fără diferențe față de ultima preluare."
          : `${diffRows} produse diferă față de marketplace.`,
        diffRows === 0 ? "ok" : "loading"
      );
    }
  } catch (err) {
    setStatus(err.message || "Eroare la comparare", "error");
    diffBody.innerHTML = `<tr class="empty-row"><td colspan="16">${escapeHtml(
      err.message || "Eroare"
    )}</td></tr>`;
  } finally {
    loading = false;
    btnReload.disabled = false;
  }
}

async function pullFromChannel() {
  if (pulling) return;
  pulling = true;
  btnPull.disabled = true;
  setStatus(`Se preiau ofertele de la ${currentChannel}…`, "loading");
  try {
    const res = await fetch(`/api/sync/pull?channel=${encodeURIComponent(currentChannel)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setStatus(
      `Preluate ${data.count} oferte (${data.created} noi, ${data.updated} actualizate).`,
      "ok"
    );
    await loadDiff();
  } catch (err) {
    setStatus(err.message || "Eroare la preluare", "error");
  } finally {
    pulling = false;
    btnPull.disabled = false;
  }
}

channelSelect.value = currentChannel;
channelSelect.addEventListener("change", () => {
  currentChannel = channelSelect.value || "emag";
  try {
    localStorage.setItem(CHANNEL_KEY, currentChannel);
  } catch {
    /* ignore */
  }
  loadDiff();
});
btnReload.addEventListener("click", loadDiff);
btnPull.addEventListener("click", pullFromChannel);
onlyDiffToggle.addEventListener("change", () => {
  if (currentData) renderDiffRows(currentData);
});

loadDiff();
