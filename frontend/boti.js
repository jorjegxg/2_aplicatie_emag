const API = "/api/boti";
const elList = document.getElementById("boti-list");
const elStatus = document.getElementById("boti-status");
const elPush = document.getElementById("boti-push");
const elCont = document.getElementById("boti-cont");
const elContInfo = document.getElementById("boti-cont-info");
const elContForm = document.getElementById("boti-cont-form");
const elRaport = document.getElementById("boti-raport");
const elAudio = document.getElementById("boti-raport-audio");
const elChat = document.getElementById("boti-chat");
const elMic = document.getElementById("boti-mic");
const elMicLabel = document.getElementById("boti-mic-label");
const elMsgForm = document.getElementById("boti-msg-form");

const ZILE = ["L", "Ma", "Mi", "J", "V", "S", "D"];
const GRAV = { mare: "status-cancelled", medie: "status-returned", mica: "status-progress" };
const STATUS_TEXT = { ruleaza: "rulează", gata: "gata", eroare: "eroare", oprit: "oprit" };

let bots = [];
let voci = [];
let current = null; // { rulare, conversatieId }
let busy = false;
let contTip = null; // "oauth" (abonament) | "api"

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

async function api(path, opts = {}) {
  const init = { credentials: "same-origin", ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(API + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const audioUrl = (name) => (name ? `${API}/audio/${encodeURIComponent(name)}` : "");

// ---------- lista boților ----------

function voiceOptions(selected) {
  return voci
    .map((v) => `<option value="${escapeHtml(v.id)}" ${v.id === selected ? "selected" : ""}>${escapeHtml(v.nume)} — ${escapeHtml(v.nota)}</option>`)
    .join("");
}

function botCard(b) {
  const p = b.program || {};
  const u = b.ultima;
  const zile = ZILE.map(
    (z, i) => `<label class="boti-day"><input type="checkbox" name="zile" value="${i + 1}" ${(p.zile || []).includes(i + 1) ? "checked" : ""} />${z}</label>`
  ).join("");
  const state = b.ruleaza
    ? `<span class="status-badge status-progress">rulează</span> <span class="muted">${escapeHtml(u?.progres || "")}</span>`
    : u
      ? `<span class="status-badge ${u.status === "eroare" ? "status-cancelled" : u.status === "gata" ? "status-finalized" : ""}">${STATUS_TEXT[u.status] || u.status}</span>
         <span class="muted">${when(u.inceput)}${u.status === "eroare" || u.status === "oprit" ? ` · ${escapeHtml(u.eroare || "")}` : ""}</span>`
      : `<span class="muted">n-a rulat încă</span>`;
  return `
  <article class="stats-card boti-card" data-id="${escapeHtml(b.id)}">
    <div class="boti-card-head">
      <div>
        <h2 class="stats-h2">${escapeHtml(b.nume)} ${b.necitite ? `<span class="boti-badge">${b.necitite} nou</span>` : ""}</h2>
        <p class="stats-card-note">${escapeHtml(b.descriere || "")}</p>
      </div>
      <label class="boti-switch" title="Pornit după program">
        <input type="checkbox" data-act="activ" ${b.activ ? "checked" : ""} />
        <span>${b.activ ? "Pornit" : "Oprit"}</span>
      </label>
    </div>
    <p class="boti-state">${state}</p>
    ${u?.rezumat && u.status === "gata" ? `<p class="boti-last">${escapeHtml(u.rezumat)}</p>` : ""}
    <p class="stats-card-note">Program: ${escapeHtml(b.program_text)}</p>
    <div class="boti-actions">
      ${b.ruleaza ? `<button type="button" class="btn btn-secondary" data-act="opreste">Oprește</button>` : `<button type="button" class="btn" data-act="porneste">Pornește acum</button>`}
      ${u && u.status === "gata" ? `<button type="button" class="btn btn-secondary" data-act="deschide" data-rid="${u.id}">Ascultă raportul</button>` : ""}
      <button type="button" class="btn btn-secondary" data-act="istoric">Rapoarte</button>
    </div>
    <div class="boti-istoric" hidden></div>
    <details class="boti-setari">
      <summary>Setări</summary>
      <form class="boti-form" data-form="setari">
        <fieldset class="boti-days"><legend>Zile</legend>${zile}</fieldset>
        <div class="boti-row">
          <label class="boti-field"><span>De la</span><input type="time" name="ora_start" value="${escapeHtml(p.ora_start || "08:00")}" /></label>
          <label class="boti-field"><span>Până la (opțional)</span><input type="time" name="ora_stop" value="${escapeHtml(p.ora_stop || "")}" /></label>
        </div>
        <div class="boti-row">
          <label class="boti-field"><span>Din câte în câte minute (0 = o dată pe zi)</span><input type="number" name="interval_min" min="0" max="1440" value="${Number(p.interval_min) || 0}" /></label>
          <label class="boti-field"><span>Durată maximă (min)</span><input type="number" name="durata_max_min" min="1" max="240" value="${Number(p.durata_max_min) || 20}" /></label>
        </div>
        ${b.id !== "discrepante" ? `<label class="boti-field"><span>Produse pe rulare</span><input type="number" name="max_produse" min="1" max="100" value="${Number(b.setari?.max_produse) || 5}" /></label>` : ""}
        <label class="boti-field"><span>Voce</span><select name="voce">${voiceOptions(b.voce?.id)}</select></label>
        <div class="boti-row">
          <label class="boti-field"><span>Viteză</span><input type="number" name="viteza" min="0.6" max="1.6" step="0.05" value="${Number(b.voce?.viteza) || 1}" /></label>
          <label class="boti-field"><span>Model Claude</span>
            <select name="model">${["haiku", "sonnet", "opus"].map((m) => `<option ${m === b.model ? "selected" : ""}>${m}</option>`).join("")}</select>
          </label>
        </div>
        <div class="boti-actions">
          <button type="submit" class="btn">Salvează</button>
          <button type="button" class="btn btn-secondary" data-act="proba">Ascultă vocea</button>
        </div>
        <audio class="boti-proba" controls hidden></audio>
      </form>
    </details>
  </article>`;
}

async function loadBots() {
  const data = await api("/");
  bots = data.boti;
  const open = new Set([...elList.querySelectorAll(".boti-setari[open]")].map((d) => d.closest(".boti-card").dataset.id));
  // Nu redesenăm cât timp editezi setările (s-ar pierde ce ai scris).
  if (open.size) {
    for (const b of bots) if (!open.has(b.id)) replaceCard(b);
    return;
  }
  elList.innerHTML = bots.map(botCard).join("");
}

function replaceCard(b) {
  const el = elList.querySelector(`.boti-card[data-id="${CSS.escape(b.id)}"]`);
  if (!el) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = botCard(b).trim();
  el.replaceWith(tmp.firstElementChild);
}

elList.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn || btn.tagName === "INPUT") return;
  const card = btn.closest(".boti-card");
  const id = card.dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === "porneste") {
      btn.disabled = true;
      const r = await api(`/bot/${id}/porneste`, { method: "POST" });
      setStatus(`Am pornit (#${r.rulare_id})`, "ok");
      await loadBots();
    } else if (act === "opreste") {
      await api(`/bot/${id}/opreste`, { method: "POST" });
      setStatus("Îl opresc…", "loading");
    } else if (act === "deschide") {
      openReport(Number(btn.dataset.rid), { play: true });
    } else if (act === "istoric") {
      const box = card.querySelector(".boti-istoric");
      if (!box.hidden) {
        box.hidden = true;
        return;
      }
      const { rulari } = await api(`/bot/${id}/rulari?limit=15`);
      box.innerHTML = rulari.length
        ? `<ul>${rulari
            .map(
              (r) => `<li><button type="button" class="boti-link" data-act="deschide" data-rid="${r.id}" ${r.status !== "gata" && r.status !== "oprit" && r.status !== "eroare" ? "disabled" : ""}>
                ${when(r.inceput)} · ${STATUS_TEXT[r.status] || r.status}${r.nr_constatari ? ` · ${r.nr_constatari} constatări` : ""}${r.citit ? "" : r.status === "gata" ? " · nou" : ""}
              </button><span class="muted"> ${escapeHtml(r.rezumat || r.eroare || "")}</span></li>`
            )
            .join("")}</ul>`
        : `<p class="muted">Niciun raport încă.</p>`;
      box.hidden = false;
    } else if (act === "proba") {
      const form = btn.closest("form");
      btn.disabled = true;
      setStatus("Generez proba…", "loading");
      const r = await api("/voci/proba", { json: { voce: form.voce.value, viteza: Number(form.viteza.value) || 1 } });
      const audio = form.querySelector(".boti-proba");
      audio.src = audioUrl(r.audio);
      audio.hidden = false;
      audio.play().catch(() => {});
      setStatus("");
      btn.disabled = false;
    }
  } catch (e) {
    setStatus(e.message, "error");
    btn.disabled = false;
  }
});

elList.addEventListener("change", async (ev) => {
  const input = ev.target.closest('input[data-act="activ"]');
  if (!input) return;
  const id = input.closest(".boti-card").dataset.id;
  try {
    const b = await api(`/bot/${id}`, { method: "PATCH", json: { activ: input.checked } });
    replaceCard(b);
    setStatus(b.activ ? `${b.nume} pornește după program` : `${b.nume} e oprit`, "ok");
  } catch (e) {
    setStatus(e.message, "error");
    input.checked = !input.checked;
  }
});

elList.addEventListener("submit", async (ev) => {
  const form = ev.target.closest('form[data-form="setari"]');
  if (!form) return;
  ev.preventDefault();
  const id = form.closest(".boti-card").dataset.id;
  const body = {
    program: {
      zile: [...form.querySelectorAll('input[name="zile"]:checked')].map((x) => Number(x.value)),
      ora_start: form.ora_start.value,
      ora_stop: form.ora_stop.value || null,
      interval_min: Number(form.interval_min.value) || 0,
      durata_max_min: Number(form.durata_max_min.value) || 20,
    },
    voce: { id: form.voce.value, viteza: Number(form.viteza.value) || 1 },
    model: form.model.value,
  };
  if (form.max_produse) body.setari = { max_produse: Number(form.max_produse.value) || 5 };
  try {
    const b = await api(`/bot/${id}`, { method: "PATCH", json: body });
    replaceCard(b);
    setStatus("Salvat", "ok");
  } catch (e) {
    setStatus(e.message, "error");
  }
});

// ---------- raportul ----------

function renderConstatari(list) {
  document.getElementById("boti-raport-count").textContent = list.length ? `(${list.length})` : "";
  document.getElementById("boti-raport-constatari").innerHTML = list.length
    ? list
        .map(
          (c) => `<div class="boti-constatare">
          <div><span class="status-badge ${GRAV[c.gravitate] || ""}">${escapeHtml(c.gravitate)}</span>
          <strong>${escapeHtml(c.produs)}</strong> <span class="muted">· ${escapeHtml(c.platforma)}</span></div>
          <p>${escapeHtml(c.problema)}</p>
          <p class="muted">→ ${escapeHtml(c.sugestie)}</p>
        </div>`
        )
        .join("")
    : `<p class="muted">Nimic de semnalat.</p>`;
}

function renderMessage(m) {
  const div = document.createElement("div");
  div.className = `boti-msg boti-msg-${m.rol}`;
  div.innerHTML = `<p>${escapeHtml(m.text)}</p>${m.audio ? `<audio controls preload="none" src="${audioUrl(m.audio)}"></audio>` : ""}`;
  elChat.appendChild(div);
  div.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return div;
}

/** Pe abonament nu se plătește separat: suma e doar echivalentul API, ca măsură a consumului din limită. */
function costText(usd) {
  const v = Number(usd).toFixed(2);
  return contTip === "api" ? `cost ${v} $ (cheie API)` : `consum ≈ ${v} $ echivalent API, inclus în abonament`;
}

async function openReport(rid, { play = false } = {}) {
  try {
    const r = await api(`/rulari/${rid}`);
    current = { rulare: r, conversatieId: r.conversatie_id };
    document.getElementById("h-raport").textContent = `${r.bot_nume} · ${when(r.inceput)}`;
    document.getElementById("boti-raport-meta").textContent =
      r.status === "gata"
        ? `${r.declansat === "program" ? "Din program" : "Pornit de tine"}${r.cost_usd ? ` · ${costText(r.cost_usd)}` : ""}`
        : `${STATUS_TEXT[r.status] || r.status}: ${r.eroare || r.progres || ""}`;
    document.getElementById("boti-raport-rezumat").textContent = r.rezumat || "";
    document.getElementById("boti-raport-text").textContent = r.text_vorbit || "";
    document.getElementById("boti-raport-text-wrap").hidden = !r.text_vorbit;
    elAudio.hidden = !r.audio;
    elAudio.src = audioUrl(r.audio);
    renderConstatari(r.constatari || []);
    elChat.innerHTML = "";
    if (r.conversatie_id) {
      const conv = await api(`/conversatii/${r.conversatie_id}`);
      conv.mesaje.forEach(renderMessage);
    }
    elRaport.hidden = false;
    elRaport.scrollIntoView({ behavior: "smooth", block: "start" });
    if (play && r.audio) elAudio.play().catch(() => {});
    if (!r.citit && r.status === "gata") api(`/rulari/${rid}/citit`, { method: "POST" }).then(loadBots).catch(() => {});
    history.replaceState(null, "", `/boti.html?rulare=${rid}`);
  } catch (e) {
    setStatus(e.message, "error");
  }
}

document.getElementById("boti-raport-close").addEventListener("click", () => {
  elRaport.hidden = true;
  elAudio.pause();
  current = null;
  history.replaceState(null, "", "/boti.html");
});

// ---------- discuția: scris sau „ține apăsat și vorbește” ----------

async function send({ text, audio }) {
  if (!current || busy) return;
  busy = true;
  const botId = current.rulare.bot_id;
  const pending = renderMessage({ rol: "eu", text: text || "🎙️ …" });
  const thinking = renderMessage({ rol: "bot", text: "mă uit…" });
  try {
    let r;
    if (audio) {
      const form = new FormData();
      const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
      form.append("audio", audio, `voce.${ext}`);
      form.append("rulare_id", current.rulare.id);
      if (current.conversatieId) form.append("conversatie_id", current.conversatieId);
      const res = await fetch(`${API}/bot/${botId}/vorbeste`, { method: "POST", body: form, credentials: "same-origin" });
      r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
      pending.querySelector("p").textContent = r.transcriere;
    } else {
      r = await api(`/bot/${botId}/mesaj`, { json: { text, rulare_id: current.rulare.id, conversatie_id: current.conversatieId } });
    }
    current.conversatieId = r.conversatie_id;
    thinking.remove();
    const msg = renderMessage({ rol: "bot", text: r.raspuns, audio: r.audio });
    msg.querySelector("audio")?.play().catch(() => {});
  } catch (e) {
    thinking.querySelector("p").textContent = `Eroare: ${e.message}`;
  } finally {
    busy = false;
  }
}

elMsgForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = elMsgForm.text.value.trim();
  if (!text) return;
  elMsgForm.text.value = "";
  send({ text });
});

let recorder = null;
let chunks = [];
let stream = null;

function pickMime() {
  for (const t of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function startRec() {
  if (recorder || busy || !current) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Browserul nu dă voie la microfon aici (trebuie HTTPS)", "error");
    return;
  }
  try {
    stream = stream || (await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }));
  } catch (e) {
    setStatus(`Microfon: ${e.message}`, "error");
    return;
  }
  elAudio.pause();
  const mime = pickMime();
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
    const tooShort = Date.now() - recorder.startedAt < 600;
    recorder = null;
    elMic.classList.remove("is-recording");
    elMicLabel.textContent = "Ține apăsat și vorbește";
    if (!tooShort && blob.size > 1000) send({ audio: blob });
  };
  recorder.startedAt = Date.now();
  recorder.start();
  elMic.classList.add("is-recording");
  elMicLabel.textContent = "Te ascult… dă drumul când ai terminat";
}

function stopRec() {
  if (recorder && recorder.state === "recording") recorder.stop();
}

elMic.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  elMic.setPointerCapture?.(e.pointerId);
  startRec();
});
elMic.addEventListener("pointerup", stopRec);
elMic.addEventListener("pointercancel", stopRec);
elMic.addEventListener("contextmenu", (e) => e.preventDefault());
elMic.addEventListener("keydown", (e) => {
  if ((e.key === " " || e.key === "Enter") && !e.repeat) {
    e.preventDefault();
    startRec();
  }
});
elMic.addEventListener("keyup", (e) => {
  if (e.key === " " || e.key === "Enter") stopRec();
});

// ---------- contul Claude ----------

function renderCont(s) {
  contTip = s.configurat ? s.tip : null;
  if (!s.configurat) {
    elContInfo.innerHTML = `<strong>Niciun cont.</strong> Boții nu pot gândi până nu pui un token.`;
    elCont.hidden = false;
    return;
  }
  const who = [s.nume, s.email, s.abonament].filter(Boolean).join(" · ");
  const ok = s.merge === true ? " · merge ✓" : s.merge === false ? ` · NU merge: ${escapeHtml(s.eroare || "")}` : "";
  elContInfo.innerHTML = `Activ: ${escapeHtml(s.tip === "api" ? "cheie API" : "abonament")} ${escapeHtml(s.token)} (din ${escapeHtml(s.sursa)})${who ? ` · ${escapeHtml(who)}` : ""}${ok}`;
}

document.getElementById("boti-cont-toggle").addEventListener("click", () => {
  elCont.hidden = !elCont.hidden;
});

document.getElementById("boti-cont-check").addEventListener("click", async () => {
  setStatus("Verific contul…", "loading");
  try {
    renderCont(await api("/setari/creier?verifica=1"));
    setStatus("");
  } catch (e) {
    setStatus(e.message, "error");
  }
});

elContForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const token = elContForm.token.value.trim();
  if (!token) return;
  setStatus("Salvez și verific…", "loading");
  try {
    renderCont(await api("/setari/creier", { method: "PUT", json: { token, nume: elContForm.nume.value } }));
    elContForm.token.value = "";
    setStatus("Cont salvat", "ok");
  } catch (e) {
    setStatus(e.message, "error");
  }
});

// ---------- browserul boților ----------

async function loadBrowser() {
  const el = document.getElementById("boti-browser");
  try {
    const b = await api("/setari/browser");
    el.textContent = !b.configurat
      ? "Browser: doar cel de rezervă (Chrome-ul de pe PC nu e configurat)"
      : b.conectat
        ? `Browser: Chrome pe PC ✓ (${b.versiune || "Chrome"}, ${b.taburi} taburi)`
        : "Browser: Chrome-ul de pe PC e oprit, boții folosesc browserul de rezervă";
  } catch (e) {
    el.textContent = `Browser: ${e.message}`;
  }
}

// ---------- notificări ----------

function b64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function pushState() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !window.isSecureContext) {
    elPush.disabled = true;
    elPush.textContent = "Notificări indisponibile aici";
    return null;
  }
  const reg = await navigator.serviceWorker.register("/sw.js");
  const sub = await reg.pushManager.getSubscription();
  elPush.textContent = sub ? "Notificări active ✓ (test)" : "Activează notificările";
  return { reg, sub };
}

elPush.addEventListener("click", async () => {
  try {
    const st = await pushState();
    if (!st) return;
    if (st.sub) {
      const r = await api("/push/test", { method: "POST" });
      setStatus(`Notificare de test trimisă (${r.trimise})`, "ok");
      return;
    }
    if ((await Notification.requestPermission()) !== "granted") {
      setStatus("Notificările sunt blocate din browser", "error");
      return;
    }
    const { cheie } = await api("/push/cheie");
    const sub = await st.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(cheie) });
    await api("/push/abonare", { json: sub.toJSON() });
    await pushState();
    setStatus("Notificări activate", "ok");
  } catch (e) {
    setStatus(`Notificări: ${e.message}`, "error");
  }
});

// ---------- evenimente live ----------

function listen() {
  const es = new EventSource(`${API}/evenimente`);
  let t = null;
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    clearTimeout(t);
    t = setTimeout(() => loadBots().catch(() => {}), ev.tip === "progres" ? 800 : 0);
    if (ev.tip === "gata") setStatus("Raport nou", "ok");
    if (ev.tip === "eroare") setStatus(`Eroare: ${ev.text}`, "error");
    if (ev.tip === "gata" && current?.rulare?.id === ev.rulare_id) openReport(ev.rulare_id);
  };
  es.onerror = () => {
    es.close();
    setTimeout(listen, 5000);
  };
}

// ---------- pornire ----------

(async () => {
  document.getElementById("boti-https").hidden = window.isSecureContext;
  setStatus("Se încarcă…", "loading");
  try {
    const [v, cont] = await Promise.all([api("/voci").catch(() => ({ voci: [] })), api("/setari/creier")]);
    voci = v.voci || [];
    renderCont(cont);
    loadBrowser();
    await loadBots();
    setStatus("");
  } catch (e) {
    setStatus(e.message, "error");
  }
  pushState().catch(() => {});
  listen();
  const rid = Number(new URLSearchParams(location.search).get("rulare"));
  if (rid) openReport(rid, { play: true });
})();
