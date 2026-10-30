const API = "/api/cod";
const elStatus = document.getElementById("cod-status");
const elChat = document.getElementById("cod-chat");
const elCereri = document.getElementById("cod-cereri");
const elAudio = document.getElementById("cod-audio");
const elTitlu = document.getElementById("h-cod-titlu");
const elMeta = document.getElementById("cod-meta");
const elMod = document.getElementById("cod-mod");
const elModel = document.getElementById("cod-model");
const elMic = document.getElementById("cod-mic");
const elMicLabel = document.getElementById("cod-mic-label");
const elStop = document.getElementById("cod-stop");
const elMsgForm = document.getElementById("cod-msg-form");
const elSesiuni = document.getElementById("cod-sesiuni");
const elSesiuniList = document.getElementById("cod-sesiuni-list");
const elSetari = document.getElementById("cod-setari");
const elSetariForm = document.getElementById("cod-setari-form");
const elPush = document.getElementById("cod-push");

const UNELTE_SCURTE = { Bash: "Comandă", Read: "Citește", Edit: "Modifică", MultiEdit: "Modifică", Write: "Scrie", Grep: "Caută", Glob: "Fișiere", WebFetch: "Web", WebSearch: "Caută pe web", TodoWrite: "Sarcini", Agent: "Agent", Task: "Agent", Skill: "Skill" };

let current = null; // session id; null = sesiune nouă
let setari = { voce: "", viteza: 1, mod: "default", model: "" };
let ruleaza = false;
let busy = false;
let liveBubble = null; // textul care se scrie acum
const tools = new Map(); // tool_use id -> element
const autoPlay = () => localStorage.getItem("cod-autoplay") !== "0";

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

function when(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ro-RO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function api(path, opts = {}) {
  const init = { credentials: "same-origin", ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch((path.startsWith("/api/") ? "" : API) + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const audioUrl = (name) => `${API}/audio/${encodeURIComponent(name)}`;

/** Markdown-ul de bază din răspunsurile lui Claude: blocuri de cod, `cod`, **bold**, titluri, linkuri. */
function md(text) {
  const parts = String(text || "").split(/```[^\n]*\n?([\s\S]*?)(?:```|$)/);
  return parts
    .map((p, i) => {
      if (i % 2) return `<pre class="cod-pre">${escapeHtml(p.replace(/\n$/, ""))}</pre>`;
      // Rândurile goale din jurul blocurilor de cod le dă deja <pre>.
      if (i > 0) p = p.replace(/^\n+/, "");
      if (i < parts.length - 1) p = p.replace(/\n+$/, "");
      return escapeHtml(p)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/^#{1,6} (.*)$/gm, "<strong>$1</strong>")
        .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    })
    .join("");
}

// Pe paginile fără tabel se derulează .page, nu documentul (vezi styles.css).
const elPage = document.querySelector(".page");

function scrollDown(behavior = "smooth") {
  elPage.scrollTo({ top: elPage.scrollHeight, behavior });
}

// ---------- conversația ----------

function addEu(text, uuid) {
  const el = document.createElement("div");
  el.className = "boti-msg boti-msg-eu";
  el.innerHTML = `<p>${escapeHtml(text)}</p>`;
  if (uuid && current) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cod-undo";
    b.textContent = "↶ anulează modificările de aici";
    b.title = "Pune fișierele înapoi cum erau înainte de mesajul ăsta";
    b.addEventListener("click", () => anuleaza(uuid));
    el.appendChild(b);
  }
  elChat.appendChild(el);
  return el;
}

function addText(text, vorbit) {
  if (liveBubble) {
    liveBubble.remove();
    liveBubble = null;
  }
  if (!text && !vorbit) return;
  const el = document.createElement("div");
  el.className = "boti-msg boti-msg-bot cod-msg";
  el.innerHTML = text ? `<div class="cod-md">${md(text)}</div>` : "";
  if (vorbit) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cod-voce";
    b.innerHTML = `🔊 <span>${escapeHtml(vorbit)}</span>`;
    b.addEventListener("click", () => speak(vorbit, b));
    el.appendChild(b);
  }
  elChat.appendChild(el);
}

function addDelta(text) {
  if (!liveBubble) {
    liveBubble = document.createElement("div");
    liveBubble.className = "boti-msg boti-msg-bot cod-msg cod-live";
    liveBubble.raw = "";
    elChat.appendChild(liveBubble);
  }
  liveBubble.raw += text;
  liveBubble.innerHTML = `<div class="cod-md">${md(liveBubble.raw.replace(/<voce>[\s\S]*$/i, ""))}</div>`;
}

function addTool({ id, nume, rezumat, sub }) {
  if (liveBubble) {
    liveBubble.remove();
    liveBubble = null;
  }
  const el = document.createElement("details");
  el.className = `cod-tool${sub ? " cod-tool-sub" : ""}`;
  const multi = String(rezumat || "").includes("\n");
  el.innerHTML = `<summary><span class="cod-tool-name">${escapeHtml(UNELTE_SCURTE[nume] || nume)}</span> <span class="cod-tool-sum">${escapeHtml(multi ? "" : rezumat)}</span></summary>${multi ? `<pre class="cod-pre">${escapeHtml(rezumat)}</pre>` : ""}<pre class="cod-pre cod-tool-out" hidden></pre>`;
  elChat.appendChild(el);
  if (id) tools.set(id, el);
}

function addResult({ id, eroare, text }) {
  const el = tools.get(id);
  if (!el) return;
  const out = el.querySelector(".cod-tool-out");
  out.textContent = text || "(fără rezultat)";
  out.hidden = false;
  if (eroare) el.classList.add("is-error");
}

function addInfo(text, kind = "") {
  const el = document.createElement("p");
  el.className = `cod-info${kind ? ` is-${kind}` : ""}`;
  el.textContent = text;
  elChat.appendChild(el);
}

function playAudio(name) {
  elAudio.hidden = false;
  elAudio.src = audioUrl(name);
  elAudio.play().catch(() => setStatus("Apasă play ca să auzi răspunsul", "ok"));
}

async function speak(text, btn) {
  if (btn) btn.disabled = true;
  try {
    const { audio } = await api("/voce", { json: { text } });
    if (audio) playAudio(audio);
  } catch (e) {
    setStatus(`Vocea: ${e.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setRuleaza(on) {
  ruleaza = Boolean(on);
  elStop.hidden = !ruleaza;
  if (ruleaza) setStatus("Lucrează…", "loading");
}

// ---------- aprobări și întrebări ----------

function renderCerere(c) {
  if (elCereri.querySelector(`[data-rid="${c.rid}"]`)) return;
  const el = document.createElement("div");
  el.className = "cod-cerere";
  el.dataset.rid = c.rid;
  const nu = `<div class="cod-nu"><input type="text" placeholder="Nu — spune-i ce să facă în loc (opțional)" /><button type="button" class="btn btn-secondary" data-r="nu">Nu</button></div>`;
  if (c.fel === "intrebare") {
    el.innerHTML =
      `<strong>Te întreabă</strong>` +
      c.intrebari
        .map(
          (q, qi) => `<fieldset class="cod-q" data-q="${qi}"><legend>${escapeHtml(q.question)}</legend>${q.options
            .map(
              (o) => `<label class="cod-opt"><input type="${q.multiSelect ? "checkbox" : "radio"}" name="q${c.rid}-${qi}" value="${escapeHtml(o.label)}" /> <span><strong>${escapeHtml(o.label)}</strong>${o.description ? ` — ${escapeHtml(o.description)}` : ""}</span></label>`
            )
            .join("")}<input type="text" class="cod-alt" placeholder="Altceva…" /></fieldset>`
        )
        .join("") +
      `<div class="boti-actions"><button type="button" class="btn" data-r="da">Trimite răspunsul</button></div>${nu}`;
  } else if (c.fel === "plan") {
    el.innerHTML =
      `<strong>Planul e gata${c.fisier ? ` <span class="stats-h2-note">${escapeHtml(c.fisier)}</span>` : ""}</strong>` +
      `<div class="cod-md cod-plan">${md(c.plan || "(planul e în fișier)")}</div>` +
      `<div class="boti-actions"><button type="button" class="btn" data-r="da" data-mod="acceptEdits">Da, cu Accept edits</button><button type="button" class="btn btn-secondary" data-r="da" data-mod="default">Da, dar întreabă la fiecare</button><button type="button" class="btn btn-secondary" data-r="da" data-mod="auto">Da, Auto</button></div>${nu}`;
  } else {
    el.innerHTML =
      `<strong>${escapeHtml(c.titlu)}</strong>` +
      (c.rezumat && c.nume !== "Bash" ? `<p class="cod-cerere-sum">${escapeHtml(c.rezumat)}</p>` : "") +
      (c.motiv ? `<p class="stats-card-note">${escapeHtml(c.motiv)}</p>` : "") +
      (c.detaliu ? `<pre class="cod-pre">${escapeHtml(c.detaliu)}</pre>` : "") +
      `<div class="boti-actions"><button type="button" class="btn" data-r="da">Da</button>${c.mereu ? `<button type="button" class="btn btn-secondary" data-r="mereu">Da, nu mai întreba</button>` : ""}</div>${nu}`;
  }
  el.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button[data-r]");
    if (!b) return;
    const body = { raspuns: b.dataset.r };
    if (b.dataset.r === "nu") body.mesaj = el.querySelector(".cod-nu input").value.trim();
    if (b.dataset.mod) body.mod = b.dataset.mod;
    if (c.fel === "intrebare" && b.dataset.r === "da") {
      body.raspunsuri = {};
      c.intrebari.forEach((q, qi) => {
        const fs = el.querySelector(`[data-q="${qi}"]`);
        const alese = [...fs.querySelectorAll("input:checked")].map((i) => i.value);
        const alt = fs.querySelector(".cod-alt").value.trim();
        body.raspunsuri[q.question] = alt || alese.join(", ");
      });
    }
    el.querySelectorAll("button").forEach((x) => (x.disabled = true));
    try {
      await api(`/cereri/${encodeURIComponent(c.rid)}`, { json: body });
    } catch (e) {
      setStatus(e.message, "error");
      el.remove();
    }
  });
  elCereri.appendChild(el);
  scrollDown();
}

function cerereGata(rid, raspuns) {
  const el = elCereri.querySelector(`[data-rid="${rid}"]`);
  if (!el) return;
  const titlu = el.querySelector("strong")?.textContent || "";
  el.remove();
  addInfo(`${raspuns === "nu" ? "✗ Refuzat" : raspuns === "anulat" ? "— Anulat" : "✓ Aprobat"}: ${titlu}`, raspuns === "nu" ? "error" : "");
}

// ---------- sesiuni ----------

function setUrl() {
  const u = new URL(location.href);
  if (current) u.searchParams.set("s", current);
  else u.searchParams.delete("s");
  history.replaceState(null, "", u);
}

function resetChat() {
  elChat.innerHTML = "";
  elCereri.innerHTML = "";
  tools.clear();
  liveBubble = null;
}

function nouaSesiune() {
  current = null;
  setUrl();
  resetChat();
  elTitlu.textContent = "Sesiune nouă";
  elMeta.textContent = "Spune sau scrie ce vrei să schimbe în aplicație.";
  elMod.value = setari.mod || "default";
  elModel.value = setari.model || "";
  setRuleaza(false);
  setStatus("");
}

async function deschide(id, { titlu } = {}) {
  current = id;
  setUrl();
  resetChat();
  elTitlu.textContent = titlu || "Sesiune";
  elMeta.textContent = "";
  setStatus("Se încarcă sesiunea…", "loading");
  try {
    const s = await api(`/sesiuni/${encodeURIComponent(id)}`);
    if (current !== id) return;
    if (s.trunchiat) addInfo("… (doar ultimele mesaje)");
    for (const m of s.mesaje) {
      if (m.tip === "eu") addEu(m.text, m.uuid);
      else if (m.tip === "text") addText(m.text, m.vorbit);
      else if (m.tip === "unealta") addTool(m);
      else if (m.tip === "rezultat") addResult(m);
    }
    for (const c of s.cereri) renderCerere(c);
    if (s.mod) elMod.value = s.mod;
    if (s.model) elModel.value = ["opus", "sonnet", "haiku"].find((x) => String(s.model).includes(x)) || "";
    elMeta.textContent = s.deschisa ? "Sesiune deschisă" : "Sesiune închisă — se redeschide la primul mesaj";
    setRuleaza(s.ruleaza);
    if (!s.ruleaza) setStatus("");
    scrollDown("auto");
  } catch (e) {
    setStatus(e.message, "error");
  }
}

async function loadSesiuni() {
  const r = await api("/sesiuni");
  setari = r.setari || setari;
  elSesiuniList.innerHTML = r.sesiuni.length
    ? r.sesiuni
        .map(
          (s) => `<li><button type="button" class="boti-link cod-ses${s.id === current ? " is-current" : ""}" data-id="${escapeHtml(s.id)}">
            <span class="cod-ses-t">${escapeHtml(s.titlu)}</span>
            <span class="stats-card-note">${when(s.modificat)}${s.ruleaza ? ' · <span class="boti-badge">lucrează</span>' : s.deschisa ? " · deschisă" : ""}${s.cereri ? ' · <span class="boti-badge">te așteaptă</span>' : ""}</span>
          </button></li>`
        )
        .join("")
    : `<li class="stats-card-note">Nicio sesiune încă.</li>`;
  return r;
}

elSesiuniList.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-id]");
  if (!b) return;
  elSesiuni.hidden = true;
  deschide(b.dataset.id, { titlu: b.querySelector(".cod-ses-t").textContent });
});

document.getElementById("cod-sesiuni-toggle").addEventListener("click", async () => {
  elSesiuni.hidden = !elSesiuni.hidden;
  if (!elSesiuni.hidden) await loadSesiuni().catch((e) => setStatus(e.message, "error"));
});

document.getElementById("cod-nou").addEventListener("click", nouaSesiune);

async function anuleaza(uuid) {
  if (!confirm("Pun fișierele înapoi cum erau înainte de mesajul ăsta? (conversația rămâne)")) return;
  setStatus("Anulez…", "loading");
  try {
    const r = await api(`/sesiuni/${encodeURIComponent(current)}/anuleaza/${encodeURIComponent(uuid)}`, { method: "POST" });
    setStatus(`Am anulat${r.filesChanged?.length ? ` (${r.filesChanged.length} fișiere)` : ""}`, "ok");
  } catch (e) {
    setStatus(e.message, "error");
  }
}

// ---------- mod și model ----------

elMod.addEventListener("change", async () => {
  const mod = elMod.value;
  if (mod === "bypassPermissions" && !confirm("Bypass: rulează orice comandă și schimbă orice fișier fără să te mai întrebe. Sigur?")) {
    elMod.value = setari.mod || "default";
    return;
  }
  try {
    setari = await api("/setari", { method: "PUT", json: { mod } });
    if (current) await api(`/sesiuni/${encodeURIComponent(current)}/mod`, { json: { mod } });
    setStatus(`Mod: ${elMod.selectedOptions[0].textContent}`, "ok");
  } catch (e) {
    setStatus(e.message, "error");
  }
});

elModel.addEventListener("change", async () => {
  const model = elModel.value;
  try {
    setari = await api("/setari", { method: "PUT", json: { model } });
    if (current) await api(`/sesiuni/${encodeURIComponent(current)}/model`, { json: { model } });
    setStatus(`Model: ${elModel.selectedOptions[0].textContent}`, "ok");
  } catch (e) {
    setStatus(e.message, "error");
  }
});

elStop.addEventListener("click", async () => {
  if (!current) return;
  try {
    await api(`/sesiuni/${encodeURIComponent(current)}/opreste`, { method: "POST" });
    setStatus("Oprit", "ok");
  } catch (e) {
    setStatus(e.message, "error");
  }
});

// ---------- trimitere (text sau voce) ----------

async function send({ text, audio }) {
  if (busy) return;
  busy = true;
  elAudio.pause();
  setStatus(audio ? "Ascult ce ai spus…" : "Trimit…", "loading");
  try {
    let r;
    if (audio) {
      const fd = new FormData();
      fd.append("audio", audio, `voce.${audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm"}`);
      fd.append("mod", elMod.value);
      fd.append("model", elModel.value);
      r = await api(`/sesiuni/${current ? encodeURIComponent(current) : "nou"}/vorbeste`, { method: "POST", body: fd });
      text = r.transcriere;
    } else if (current) {
      r = await api(`/sesiuni/${encodeURIComponent(current)}/mesaj`, { json: { text } });
    } else {
      r = await api("/sesiuni", { json: { text, mod: elMod.value, model: elModel.value } });
    }
    if (r.sessionId && r.sessionId !== current) {
      current = r.sessionId;
      setUrl();
      elTitlu.textContent = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      elMeta.textContent = "Sesiune deschisă";
    }
    if (r.raspuns_la) addInfo(`Tu: „${text}”`);
    else {
      addEu(text, r.uuid);
      setRuleaza(true);
    }
    scrollDown();
  } catch (e) {
    setStatus(e.message, "error");
  } finally {
    busy = false;
  }
}

elMsgForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = elMsgForm.text.value.trim();
  if (!text) return;
  elMsgForm.text.value = "";
  elMsgForm.text.style.height = "";
  send({ text });
});

elMsgForm.text.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    elMsgForm.requestSubmit();
  }
});
elMsgForm.text.addEventListener("input", () => {
  const t = elMsgForm.text;
  t.style.height = "";
  t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
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
  if (recorder || busy) return;
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

// ---------- vocea ----------

document.getElementById("cod-setari-toggle").addEventListener("click", async () => {
  elSetari.hidden = !elSetari.hidden;
  if (elSetari.hidden) return;
  try {
    const { voci = [] } = await api("/voci");
    elSetariForm.voce.innerHTML = voci.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.nume)}${v.nota ? ` — ${escapeHtml(v.nota)}` : ""}</option>`).join("");
  } catch (e) {
    setStatus(`Vocile: ${e.message}`, "error");
  }
  elSetariForm.voce.value = setari.voce || "";
  elSetariForm.viteza.value = setari.viteza || 1;
  elSetariForm.auto.checked = autoPlay();
});

elSetariForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  localStorage.setItem("cod-autoplay", elSetariForm.auto.checked ? "1" : "0");
  try {
    setari = await api("/setari", { method: "PUT", json: { voce: elSetariForm.voce.value, viteza: Number(elSetariForm.viteza.value) } });
    setStatus("Vocea salvată", "ok");
  } catch (e) {
    setStatus(e.message, "error");
  }
});

document.getElementById("cod-proba").addEventListener("click", async (ev) => {
  try {
    setari = await api("/setari", { method: "PUT", json: { voce: elSetariForm.voce.value, viteza: Number(elSetariForm.viteza.value) } });
    await speak("Gata. Am schimbat subtitlul paginii Boți și am repornit front-ul. Reîncarcă pagina și spune-mi dacă arată bine.", ev.currentTarget);
  } catch (e) {
    setStatus(e.message, "error");
  }
});

// ---------- notificări (aceleași abonări ca pagina Boți) ----------

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
  elPush.textContent = sub ? "Notificări active ✓" : "Activează notificările";
  return { reg, sub };
}

elPush.addEventListener("click", async () => {
  try {
    const st = await pushState();
    if (!st || st.sub) return;
    if ((await Notification.requestPermission()) !== "granted") {
      setStatus("Notificările sunt blocate din browser", "error");
      return;
    }
    const { cheie } = await api("/api/boti/push/cheie");
    const sub = await st.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(cheie) });
    await api("/api/boti/push/abonare", { json: sub.toJSON() });
    await pushState();
    setStatus("Notificări activate", "ok");
  } catch (e) {
    setStatus(`Notificări: ${e.message}`, "error");
  }
});

// ---------- evenimente live ----------

function onEvent(ev) {
  if (ev.sessionId !== current) {
    if (ev.tip === "cerere") setStatus("O altă sesiune te așteaptă (vezi Sesiuni)", "ok");
    return;
  }
  switch (ev.tip) {
    case "delta":
      addDelta(ev.text);
      break;
    case "text":
      addText(ev.text, ev.vorbit);
      break;
    case "unealta":
      addTool(ev);
      break;
    case "rezultat":
      addResult(ev);
      break;
    case "cerere":
      renderCerere(ev.cerere);
      setStatus("Te așteaptă să aprobi", "ok");
      break;
    case "cerere-gata":
      cerereGata(ev.rid, ev.raspuns);
      break;
    case "audio":
      if (autoPlay() && !recorder) playAudio(ev.audio);
      break;
    case "stare":
      setRuleaza(ev.ruleaza);
      break;
    case "gata":
      if (liveBubble) addText(liveBubble.raw.replace(/<voce>[\s\S]*$/i, "").trim());
      setStatus(ev.ok ? `Gata${ev.cost ? ` · ${ev.cost.toFixed(2)} $` : ""}${ev.durata ? ` · ${Math.round(ev.durata / 1000)} s` : ""}` : `Eroare: ${ev.eroare}`, ev.ok ? "ok" : "error");
      break;
    case "mod":
      elMod.value = ev.mod;
      break;
    case "init":
      elMeta.textContent = `Sesiune deschisă · ${ev.model || ""}`;
      if (ev.mod) elMod.value = ev.mod;
      break;
    case "info":
      addInfo(ev.text);
      break;
    case "eroare":
      addInfo(`Eroare: ${ev.text}`, "error");
      setStatus(ev.text, "error");
      break;
    case "inchis":
      setRuleaza(false);
      elMeta.textContent = "Sesiune închisă — se redeschide la primul mesaj";
      break;
    default:
      return;
  }
  if (ev.tip !== "audio" && ev.tip !== "mod") scrollDown();
}

function listen() {
  const es = new EventSource(`${API}/evenimente`);
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onerror = () => {
    es.close();
    setTimeout(() => {
      // După o reconectare, istoria vine din fișierul sesiunii (poate am pierdut evenimente).
      if (current && !busy) deschide(current, { titlu: elTitlu.textContent });
      listen();
    }, 5000);
  };
}

// ---------- pornire ----------

(async () => {
  document.getElementById("cod-https").hidden = window.isSecureContext;
  try {
    const r = await loadSesiuni();
    const id = new URLSearchParams(location.search).get("s");
    if (id) {
      const s = r.sesiuni.find((x) => x.id === id);
      await deschide(id, { titlu: s?.titlu });
    } else nouaSesiune();
  } catch (e) {
    setStatus(e.message.includes("HTTP 502") || e.message.includes("HTTP 504") ? "Serviciul Claude Code (emag-cod) nu rulează pe PC" : e.message, "error");
  }
  pushState().catch(() => {});
  listen();
})();
