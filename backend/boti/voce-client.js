/** Clientul pentru serviciul `voce` (TTS + STT). Fișierele MP3 stau în data/boti/audio. */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VOCE_URL = String(process.env.VOCE_URL || "http://voce:8000").replace(/\/$/, "");
const AUDIO_DIR = path.join(__dirname, "..", "data", "boti", "audio");

async function voci() {
  const res = await fetch(`${VOCE_URL}/voci`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`voce: HTTP ${res.status}`);
  return res.json();
}

async function health() {
  try {
    const res = await fetch(`${VOCE_URL}/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok ? await res.json() : { ok: false };
  } catch (e) {
    return { ok: false, eroare: e.message };
  }
}

/** Textul → MP3 salvat → numele fișierului (pentru /api/boti/audio/<nume>). */
async function tts(text, { voce, viteza = 1, prefix = "a" } = {}) {
  const res = await fetch(`${VOCE_URL}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voce, viteza }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`voce: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const name = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.mp3`;
  fs.writeFileSync(path.join(AUDIO_DIR, name), buf);
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

function audioPath(name) {
  const safe = path.basename(String(name || ""));
  if (!/^[\w.-]+\.mp3$/.test(safe)) return null;
  const p = path.join(AUDIO_DIR, safe);
  return fs.existsSync(p) ? p : null;
}

module.exports = { voci, health, tts, stt, audioPath, AUDIO_DIR };
