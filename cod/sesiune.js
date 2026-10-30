/**
 * Sesiunile Claude Code ale paginii: aceleași sesiuni ca în terminal (~/.claude/projects/…), pornite
 * cu Agent SDK pe PC, în repo. O sesiune deschisă = un query() în modul streaming input, ținut viu
 * cât lucrezi; se închide singur după IDLE_MS fără activitate și se reia (resume) la următorul mesaj.
 *
 * Tot ce se întâmplă (text, unelte, aprobări, rezumatul vorbit) pleacă pe `events` → SSE în pagină.
 */
const crypto = require("crypto");
const path = require("path");
const { EventEmitter } = require("events");
const voce = require("./voce");

const REPO = path.resolve(__dirname, "..");
const IDLE_MS = 30 * 60_000;
const MODURI = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

let sdkPromise = null;
const sdk = () => (sdkPromise = sdkPromise || import("@anthropic-ai/claude-agent-sdk"));

const events = new EventEmitter();
events.setMaxListeners(50);
const live = new Map(); // sessionId -> Sesiune
const cereri = new Map(); // rid -> cerere de aprobare / întrebare în așteptare

let push = null;
function notify(payload) {
  try {
    push = push || require("../backend/boti/push");
    push.notify({ url: "/cod.html", ...payload }).catch((e) => console.log(`push: ${e.message}`));
  } catch (e) {
    console.log(`push: ${e.message}`);
  }
}

const emit = (sessionId, ev) => events.emit("ev", { sessionId, ...ev });

function rel(p) {
  const s = String(p || "");
  return s.startsWith(REPO + "/") ? s.slice(REPO.length + 1) : s;
}

function cut(s, n) {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Un rând scurt pentru o unealtă folosită: „Edit frontend/base.js”, „Bash: docker compose …”. */
function descrie(nume, input = {}) {
  switch (nume) {
    case "Bash":
      return cut(input.description ? `${input.description} — ${input.command}` : input.command, 300);
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return rel(input.file_path || input.notebook_path);
    case "Grep":
      return cut(`${input.pattern}${input.path ? ` în ${rel(input.path)}` : ""}`, 200);
    case "Glob":
      return cut(input.pattern, 200);
    case "WebFetch":
      return cut(input.url, 200);
    case "WebSearch":
      return cut(input.query, 200);
    case "Agent":
    case "Task":
      return cut(input.description || input.prompt, 200);
    case "TodoWrite":
      return (input.todos || []).map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "·"} ${t.content}`).join("\n");
    case "Skill":
      return input.skill || "";
    default:
      return cut(JSON.stringify(input), 200);
  }
}

/** Ce vede utilizatorul în cardul de aprobare: comanda întreagă, diff-ul, conținutul. */
function detaliu(nume, input = {}) {
  if (nume === "Bash") return String(input.command || "");
  if (nume === "Edit") return `- ${cut(input.old_string, 1500)}\n+ ${cut(input.new_string, 1500)}`;
  if (nume === "MultiEdit") return (input.edits || []).map((e) => `- ${cut(e.old_string, 600)}\n+ ${cut(e.new_string, 600)}`).join("\n\n");
  if (nume === "Write") return cut(input.content, 2500);
  return cut(JSON.stringify(input, null, 2), 2500);
}

/** Ce spune cu voce când cere aprobare. */
function intrebareVorbita(nume, input, title) {
  const fisier = path.basename(String(input.file_path || input.notebook_path || ""));
  if (nume === "Bash") return `Vreau să rulez o comandă${input.description ? `: ${input.description}` : ""}. Aprobi?`;
  if (nume === "Write") return `Vreau să scriu fișierul ${fisier}. Aprobi?`;
  if (["Edit", "MultiEdit", "NotebookEdit"].includes(nume)) return `Vreau să modific fișierul ${fisier}. Aprobi?`;
  return `${title || `Vreau să folosesc ${nume}`}. Aprobi?`;
}

function textBlocks(content) {
  if (typeof content === "string") return [content];
  return (Array.isArray(content) ? content : []).filter((b) => b?.type === "text").map((b) => b.text);
}

function resultText(content) {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "[imagine]" : "")).join("\n");
}

// ---------- cereri de aprobare ----------

function cererePublica(c) {
  const { resolve, input, suggestions, ...rest } = c;
  return rest;
}

function cereriSesiune(sessionId) {
  return [...cereri.values()].filter((c) => c.sessionId === sessionId).map(cererePublica);
}

/**
 *   raspuns   "da" | "mereu" | "nu"
 *   mesaj     la „nu”: ce să facă în loc (ajunge la Claude)
 *   raspunsuri  la întrebări: { "<întrebarea>": "<varianta>" }
 *   mod       la plan: modul după aprobare (acceptEdits | default | auto | bypassPermissions)
 */
function raspunde(rid, { raspuns, mesaj, raspunsuri, mod } = {}) {
  const c = cereri.get(rid);
  if (!c) {
    const err = new Error("Cererea nu mai există (a expirat sau ai răspuns deja)");
    err.status = 404;
    throw err;
  }
  cereri.delete(rid);
  let result;
  if (raspuns === "nu") {
    const motiv = String(mesaj || "").trim();
    result = {
      behavior: "deny",
      message:
        c.fel === "plan"
          ? `Utilizatorul nu a aprobat planul${motiv ? `: ${motiv}` : ". Rămâi în modul plan și întreabă-l ce să schimbi."}`
          : motiv
            ? `Utilizatorul a refuzat și a spus: ${motiv}`
            : "Utilizatorul a refuzat. Oprește-te și întreabă-l ce vrea.",
    };
  } else if (c.fel === "intrebare") {
    result = { behavior: "allow", updatedInput: { ...c.input, answers: { ...(raspunsuri || {}) } } };
  } else if (c.fel === "plan") {
    const next = MODURI.includes(mod) && mod !== "plan" ? mod : "acceptEdits";
    result = { behavior: "allow", updatedInput: c.input, updatedPermissions: [{ type: "setMode", mode: next, destination: "session" }] };
    const s = live.get(c.sessionId);
    if (s) s.mod = next;
    emit(c.sessionId, { tip: "mod", mod: next });
  } else {
    result = { behavior: "allow", updatedInput: c.input };
    if (raspuns === "mereu" && c.suggestions?.length) result.updatedPermissions = c.suggestions;
  }
  emit(c.sessionId, { tip: "cerere-gata", rid, raspuns: raspuns === "nu" ? "nu" : "da" });
  c.resolve(result);
  return { ok: true };
}

const fara = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const DA = /^(da|aprob|aproba|ok|okay|sigur|fa-o|fa o|continua|bine|merge|da-i|da i|accept|corect|exact)\b/;
const NU = /^(nu|stai|opreste|anuleaza|refuz|lasa)\b/;
const ORDIN = [/\b(prima|primul|unu|1)\b/, /\b(a doua|al doilea|doi|doua|2)\b/, /\b(a treia|al treilea|trei|3)\b/, /\b(a patra|al patrulea|patru|4)\b/];

/** Răspunsul spus cu vocea la o cerere în așteptare. */
function raspundeVocal(c, text) {
  const t = fara(text).replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
  if (c.fel === "intrebare") {
    if (NU.test(t) && t.split(" ").length <= 2) return raspunde(c.rid, { raspuns: "nu" });
    const raspunsuri = {};
    for (const q of c.intrebari) {
      const opt = q.options.find((o) => t.includes(fara(o.label))) || q.options.find((o, i) => ORDIN[i]?.test(t));
      raspunsuri[q.question] = opt ? opt.label : String(text).trim();
    }
    return raspunde(c.rid, { raspuns: "da", raspunsuri });
  }
  if (DA.test(t) && t.split(" ").length <= 4) return raspunde(c.rid, { raspuns: "da" });
  // „nu”, sau orice altceva = refuz cu instrucțiunile tale pentru Claude.
  return raspunde(c.rid, { raspuns: "nu", mesaj: NU.test(t) && t.split(" ").length <= 2 ? "" : String(text).trim() });
}

// ---------- sesiunea vie ----------

class Sesiune {
  constructor(sessionId, { nou, mod, model }) {
    this.id = sessionId;
    this.nou = nou;
    this.mod = MODURI.includes(mod) ? mod : "default";
    this.model = model || null;
    this.queue = [];
    this.wake = null;
    this.closed = false;
    this.ruleaza = false;
    this.timer = null;
  }

  async start() {
    const { query } = await sdk();
    const options = {
      cwd: REPO,
      systemPrompt: { type: "preset", preset: "claude_code", append: voce.INSTRUCTIUNI },
      settingSources: ["user", "project", "local"],
      permissionMode: this.mod,
      allowDangerouslySkipPermissions: true,
      enableFileCheckpointing: true,
      includePartialMessages: true,
      canUseTool: (nume, input, opts) => this.canUseTool(nume, input, opts),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "emag-cod/1.0" },
      stderr: (d) => process.stderr.write(`[${this.id.slice(0, 8)}] ${d}`),
    };
    if (this.model) options.model = this.model;
    if (this.nou) options.sessionId = this.id;
    else options.resume = this.id;
    this.q = query({ prompt: this.input(), options });
    this.touch();
    this.pump();
  }

  async *input() {
    while (!this.closed) {
      if (this.queue.length) {
        yield this.queue.shift();
        continue;
      }
      await new Promise((r) => (this.wake = r));
      this.wake = null;
    }
  }

  send(text) {
    const uuid = crypto.randomUUID();
    this.queue.push({ type: "user", uuid, session_id: this.id, parent_tool_use_id: null, message: { role: "user", content: text } });
    this.ruleaza = true;
    this.wake?.();
    this.touch();
    emit(this.id, { tip: "eu", uuid, text });
    emit(this.id, { tip: "stare", ruleaza: true });
    return uuid;
  }

  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.ruleaza || cereriSesiune(this.id).length) return this.touch();
      this.close();
    }, IDLE_MS);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.wake?.();
    try {
      this.q?.close();
    } catch {
      /* deja închis */
    }
  }

  async canUseTool(nume, input, { signal, suggestions, title, displayName, decisionReason }) {
    const rid = crypto.randomUUID();
    const c = { rid, sessionId: this.id, nume, titlu: title || displayName || nume, motiv: decisionReason || null, creat: Date.now() };
    if (nume === "AskUserQuestion") {
      c.fel = "intrebare";
      c.intrebari = (input.questions || []).map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: Boolean(q.multiSelect),
        options: (q.options || []).map((o) => ({ label: o.label, description: o.description })),
      }));
    } else if (nume === "ExitPlanMode") {
      c.fel = "plan";
      c.plan = String(input.plan || "");
      c.fisier = input.planFilePath ? rel(input.planFilePath) : null;
    } else {
      c.fel = "permisiune";
      c.rezumat = descrie(nume, input);
      c.detaliu = detaliu(nume, input);
      c.mereu = Boolean(suggestions?.length);
    }
    const promise = new Promise((resolve) => (c.resolve = resolve));
    cereri.set(rid, { ...c, input, suggestions });
    signal?.addEventListener(
      "abort",
      () => {
        if (!cereri.delete(rid)) return;
        emit(this.id, { tip: "cerere-gata", rid, raspuns: "anulat" });
        c.resolve({ behavior: "deny", message: "anulat" });
      },
      { once: true }
    );
    emit(this.id, { tip: "cerere", cerere: c });

    const vorbit =
      c.fel === "intrebare"
        ? c.intrebari.map((q) => `${q.question} Variantele: ${q.options.map((o) => o.label).join(", ")}.`).join(" ")
        : c.fel === "plan"
          ? "Planul e gata. Te uiți pe el și îmi spui dacă îl aprobi?"
          : intrebareVorbita(nume, input, title);
    notify({ title: "Claude Code te întreabă", body: vorbit, tag: `cod-${this.id}`, url: `/cod.html?s=${this.id}` });
    voce
      .tts(vorbit)
      .then((audio) => audio && emit(this.id, { tip: "audio", audio, text: vorbit, rid }))
      .catch((e) => emit(this.id, { tip: "info", text: `Vocea: ${e.message}` }));
    return promise;
  }

  async pump() {
    try {
      for await (const m of this.q) {
        this.touch();
        this.handle(m);
      }
    } catch (e) {
      if (!this.closed) emit(this.id, { tip: "eroare", text: e.message });
    } finally {
      this.closed = true;
      this.ruleaza = false;
      clearTimeout(this.timer);
      if (live.get(this.id) === this) live.delete(this.id);
      for (const c of [...cereri.values()]) {
        if (c.sessionId !== this.id) continue;
        cereri.delete(c.rid);
        c.resolve({ behavior: "deny", message: "sesiune închisă" });
        emit(this.id, { tip: "cerere-gata", rid: c.rid, raspuns: "anulat" });
      }
      emit(this.id, { tip: "inchis" });
    }
  }

  handle(m) {
    if (m.type === "system" && m.subtype === "init") {
      this.model = m.model || this.model;
      if (m.permissionMode) this.mod = m.permissionMode;
      emit(this.id, { tip: "init", model: this.model, mod: this.mod });
      return;
    }
    if (m.type === "system" && m.subtype === "compact_boundary") {
      emit(this.id, { tip: "info", text: "Conversația a fost compactată." });
      return;
    }
    if (m.type === "stream_event") {
      if (m.parent_tool_use_id) return;
      const ev = m.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") emit(this.id, { tip: "delta", text: ev.delta.text });
      return;
    }
    if (m.type === "assistant") {
      const sub = Boolean(m.parent_tool_use_id);
      for (const b of m.message?.content || []) {
        if (b.type === "text" && !sub) {
          const { afisat, vorbit } = voce.split(b.text);
          emit(this.id, { tip: "text", uuid: m.uuid, text: afisat, vorbit });
        } else if (b.type === "tool_use") {
          emit(this.id, { tip: "unealta", id: b.id, nume: b.name, rezumat: descrie(b.name, b.input), sub });
        }
      }
      return;
    }
    if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type === "tool_result") emit(this.id, { tip: "rezultat", id: b.tool_use_id, eroare: Boolean(b.is_error), text: cut(resultText(b.content), 4000) });
      }
      return;
    }
    if (m.type === "result") {
      this.ruleaza = false;
      const ok = m.subtype === "success" && !m.is_error;
      const eroare = ok ? null : String(m.result || (m.errors || []).join("; ") || m.subtype).slice(0, 500);
      emit(this.id, { tip: "gata", ok, eroare, cost: Number(m.total_cost_usd) || null, durata: m.duration_ms || null });
      emit(this.id, { tip: "stare", ruleaza: false });
      this.vorbeste(ok ? m.result : eroare, ok).catch((e) => emit(this.id, { tip: "info", text: `Vocea: ${e.message}` }));
    }
  }

  /** Rezumatul vorbit de la finalul cererii: blocul <voce>, altfel un rezumat scurt făcut de haiku. */
  async vorbeste(text, ok) {
    let { vorbit, afisat } = voce.split(text);
    if (!vorbit && !ok) vorbit = `Am dat de o eroare: ${cut(afisat, 200)}`;
    if (!vorbit && afisat) vorbit = await rezumatScurt(afisat);
    if (!vorbit) return;
    notify({ title: "Claude Code a terminat", body: vorbit, tag: `cod-${this.id}`, url: `/cod.html?s=${this.id}` });
    const audio = await voce.tts(vorbit);
    if (audio) emit(this.id, { tip: "audio", audio, text: vorbit, final: true });
  }
}

async function rezumatScurt(text) {
  const { query } = await sdk();
  const q = query({
    prompt:
      "Spune în 2–3 propoziții scurte în română, ca la telefon, ce scrie mai jos (ce s-a făcut și ce trebuie verificat). Fără cod, căi, comenzi, markdown sau emoji. Doar textul de citit.\n\n" +
      cut(text, 6000),
    options: { model: "haiku", cwd: voce.DATA_DIR, tools: [], settingSources: [], persistSession: false, maxTurns: 1 },
  });
  for await (const m of q) if (m.type === "result" && m.subtype === "success") return String(m.result || "").trim();
  return "";
}

// ---------- API pentru server.js ----------

async function deschide(sessionId, { nou = false, mod, model } = {}) {
  let s = live.get(sessionId);
  if (s && !s.closed) return s;
  s = new Sesiune(sessionId, { nou, mod: mod || voce.setari().mod, model: model || voce.setari().model });
  live.set(sessionId, s);
  try {
    await s.start();
  } catch (e) {
    live.delete(sessionId);
    throw e;
  }
  return s;
}

async function sesiuneNoua(text, { mod, model } = {}) {
  const id = crypto.randomUUID();
  const s = await deschide(id, { nou: true, mod, model });
  const uuid = s.send(text);
  return { sessionId: id, uuid };
}

async function mesaj(sessionId, text) {
  // Cât așteaptă o aprobare, mesajul scris răspunde la ea (ca în terminal).
  const c = [...cereri.values()].find((x) => x.sessionId === sessionId);
  if (c) {
    raspundeVocal(c, text);
    return { raspuns_la: c.rid };
  }
  const s = await deschide(sessionId);
  return { uuid: s.send(text) };
}

async function setMod(sessionId, mod) {
  if (!MODURI.includes(mod)) {
    const err = new Error("Mod necunoscut");
    err.status = 400;
    throw err;
  }
  const s = live.get(sessionId);
  if (s && !s.closed) {
    await s.q.setPermissionMode(mod);
    s.mod = mod;
  }
  emit(sessionId, { tip: "mod", mod });
  return { mod };
}

async function setModel(sessionId, model) {
  const s = live.get(sessionId);
  if (s && !s.closed) {
    await s.q.setModel(model || undefined);
    s.model = model || null;
  }
  emit(sessionId, { tip: "model", model: model || null });
  return { model: model || null };
}

async function opreste(sessionId) {
  const s = live.get(sessionId);
  if (!s || s.closed) return { oprit: false };
  for (const c of [...cereri.values()]) if (c.sessionId === sessionId) raspunde(c.rid, { raspuns: "nu", mesaj: "Oprește." });
  await s.q.interrupt();
  return { oprit: true };
}

async function anuleaza(sessionId, uuid) {
  const s = await deschide(sessionId);
  const r = await s.q.rewindFiles(uuid);
  if (!r?.canRewind) {
    const err = new Error(r?.error || "Nu am ce anula pentru mesajul ăsta");
    err.status = 409;
    throw err;
  }
  const n = r.filesChanged?.length;
  emit(sessionId, { tip: "info", text: `Am pus fișierele înapoi cum erau înainte de mesajul ăsta${n ? ` (${n} fișiere)` : ""}.` });
  return r;
}

async function lista(limit = 40) {
  const { listSessions } = await sdk();
  const rows = await listSessions({ dir: REPO, limit });
  return rows.map((r) => {
    const s = live.get(r.sessionId);
    return {
      id: r.sessionId,
      titlu: r.customTitle || r.summary || r.firstPrompt || r.sessionId,
      prima: r.firstPrompt || null,
      modificat: r.lastModified,
      creat: r.createdAt || null,
      deschisa: Boolean(s && !s.closed),
      ruleaza: Boolean(s?.ruleaza),
      cereri: cereriSesiune(r.sessionId).length,
    };
  });
}

function ascuns(text) {
  const t = String(text || "").trim();
  return !t || /^<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification)/.test(t) || t.startsWith("Caveat:");
}

/** Istoria unei sesiuni, din fișierul ei, ca listă de mesaje pentru pagină. */
async function istoric(sessionId) {
  const { getSessionMessages } = await sdk();
  const msgs = await getSessionMessages(sessionId, { dir: REPO });
  const out = [];
  for (const m of msgs) {
    if (m.parent_tool_use_id || m.type === "system") continue;
    const content = m.message?.content;
    if (m.type === "user") {
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === "tool_result") out.push({ tip: "rezultat", id: b.tool_use_id, eroare: Boolean(b.is_error), text: cut(resultText(b.content), 4000) });
      }
      for (const t of textBlocks(content)) {
        if (ascuns(t)) continue;
        const cmd = t.match(/<command-name>([^<]*)<\/command-name>/);
        if (cmd) out.push({ tip: "eu", uuid: m.uuid, text: cmd[1] });
        else if (!t.startsWith("<")) out.push({ tip: "eu", uuid: m.uuid, text: t });
      }
    } else if (m.type === "assistant") {
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === "text") {
          const { afisat, vorbit } = voce.split(b.text);
          out.push({ tip: "text", uuid: m.uuid, text: afisat, vorbit });
        } else if (b.type === "tool_use") out.push({ tip: "unealta", id: b.id, nume: b.name, rezumat: descrie(b.name, b.input) });
      }
    }
  }
  const s = live.get(sessionId);
  return {
    id: sessionId,
    mesaje: out.slice(-400),
    trunchiat: out.length > 400,
    deschisa: Boolean(s && !s.closed),
    ruleaza: Boolean(s?.ruleaza),
    mod: s?.mod || null,
    model: s?.model || null,
    cereri: cereriSesiune(sessionId),
  };
}

function cerereInAsteptare(sessionId) {
  return [...cereri.values()].find((c) => c.sessionId === sessionId) || null;
}

function inchideTot() {
  for (const s of live.values()) s.close();
}

module.exports = {
  events,
  MODURI,
  REPO,
  lista,
  istoric,
  sesiuneNoua,
  mesaj,
  raspunde,
  raspundeVocal,
  cerereInAsteptare,
  setMod,
  setModel,
  opreste,
  anuleaza,
  inchideTot,
};
