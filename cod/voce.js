/**
 * Vocea paginii Claude Code: rezumatul vorbit (blocul <voce>…</voce> de la finalul răspunsului) și
 * întrebările scurte la aprobări, prin serviciul `voce` (TTS) din docker compose.
 *
 * Fișierele MP3 au numele din hash-ul textului, ca istoria unei sesiuni să-și găsească audio-ul
 * și după restart (sau să-l facă la cerere).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VOCE_URL = String(process.env.VOCE_URL || "http://127.0.0.1:8100").replace(/\/$/, "");
const DATA_DIR = path.join(__dirname, "..", "backend", "data", "cod");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const SETARI_FILE = path.join(DATA_DIR, "setari.json");

const DEFAULTS = { voce: "piper:liana-high", viteza: 1.05, mod: "default", model: "" };

// Pus la finalul promptului de sistem Claude Code (systemPrompt.append).
const INSTRUCTIUNI = `
# Vocea (pagina Claude Code din aplicație)
Utilizatorul îți vorbește din aplicația web, de pe telefon, și te AUDE: la finalul fiecărui răspuns de la sfârșitul unei cereri (nu și la mesajele intermediare dintre unelte) adaugă pe ultimul rând un bloc
<voce>…</voce>
cu 2–4 propoziții scurte în română, la persoana întâi, ca și cum i-ai spune la telefon: ce ai făcut / ce ai aflat și ce trebuie să verifice sau să decidă el. Fără cod, căi de fișiere, comenzi, ID-uri, liste, markdown sau emoji; numerele scrise cum se pronunță firesc. Textul din bloc nu apare pe ecran, doar se aude; restul răspunsului rămâne ca de obicei.
Când rulezi pe PC (nu în Docker): repo-ul e /home/gxg/2_aplicatie_emag; containerele se pornesc cu docker compose din rădăcina repo-ului. Serviciul acestei pagini e cod/ (systemd: emag-cod); dacă îl modifici, spune-i utilizatorului că trebuie repornit cu systemctl --user restart emag-cod și că sesiunea curentă se va întrerupe — nu-l reporni singur.
`.trim();

const VOCE_RE = /<voce>([\s\S]*?)(?:<\/voce>|$)/i;

/** Textul afișat (fără blocul <voce>) și textul vorbit. */
function split(text) {
  const s = String(text || "");
  const m = s.match(VOCE_RE);
  if (!m) return { afisat: s.trim(), vorbit: "" };
  return { afisat: s.replace(VOCE_RE, "").trim(), vorbit: m[1].replace(/\s+/g, " ").trim() };
}

function setari() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETARI_FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSetari(patch) {
  const next = { ...setari(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETARI_FILE, JSON.stringify(next, null, 2));
  return next;
}

function audioName(text, voce, viteza) {
  const h = crypto.createHash("sha1").update(`${voce}|${viteza}|${text}`).digest("hex").slice(0, 20);
  return `cod-${h}.mp3`;
}

/** Textul → MP3 (refolosit dacă există deja) → numele fișierului. */
async function tts(text) {
  const t = String(text || "").trim().slice(0, 1500);
  if (!t) return null;
  const { voce, viteza } = setari();
  const name = audioName(t, voce, viteza);
  const file = path.join(AUDIO_DIR, name);
  if (fs.existsSync(file)) return name;
  const res = await fetch(`${VOCE_URL}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: t, voce, viteza }),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!res.ok) throw new Error(`voce: ${(await res.text()).slice(0, 200)}`);
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return name;
}

/** Audio înregistrat (webm/ogg/m4a/wav) → text. */
async function stt(buffer, { filename = "voce.webm", mimetype = "audio/webm" } = {}) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimetype }), filename);
  const res = await fetch(`${VOCE_URL}/stt`, { method: "POST", body: form, signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`transcriere: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function voci() {
  const res = await fetch(`${VOCE_URL}/voci`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`voce: HTTP ${res.status}`);
  return res.json();
}

function audioPath(name) {
  const safe = path.basename(String(name || ""));
  if (!/^[\w.-]+\.mp3$/.test(safe)) return null;
  const p = path.join(AUDIO_DIR, safe);
  return fs.existsSync(p) ? p : null;
}

module.exports = { INSTRUCTIUNI, split, setari, saveSetari, tts, stt, voci, audioPath, DATA_DIR };
