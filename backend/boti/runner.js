/**
 * Rularea boților: pornire (manual sau din program), oprire, raport → voce → notificare,
 * plus conversația cu botul după raport. Evenimentele pleacă pe `events` (SSE în pagina Boți).
 */
const { EventEmitter } = require("events");
const { query } = require("../pg");
const brain = require("./brain");
const tools = require("./tools");
const voce = require("./voce-client");
const push = require("./push");
const { systemPrompt } = require("./bots/common");

const BOTS = Object.fromEntries([require("./bots/discrepante"), require("./bots/poze-preturi"), require("./bots/seo")].map((b) => [b.id, b]));
const DEFAULT_VOICE = { id: "piper:liana-high", viteza: 1 };

const events = new EventEmitter();
events.setMaxListeners(100);
const running = new Map(); // bot_id → { rulareId, controller, timer }

const log = (s) => console.log(`${new Date().toISOString().slice(0, 16).replace("T", " ")} ${s}`);

async function getBot(id) {
  const { rows } = await query(`SELECT * FROM boti WHERE id = $1`, [id]);
  if (!rows[0]) {
    const err = new Error(`Botul ${id} nu există`);
    err.status = 404;
    throw err;
  }
  return rows[0];
}

async function setRun(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await query(`UPDATE boti_rulari SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
}

/** Pornește botul; întoarce id-ul rulării. Dacă rulează deja, întoarce rularea curentă. */
async function start(botId, { declansat = "manual" } = {}) {
  if (running.has(botId)) return running.get(botId).rulareId;
  const bot = await getBot(botId);
  const impl = BOTS[botId];
  if (!impl) throw new Error(`Botul ${botId} nu are implementare`);

  const { rows } = await query(`INSERT INTO boti_rulari (bot_id, declansat, progres) VALUES ($1, $2, 'pornesc') RETURNING id`, [botId, declansat]);
  const rulareId = rows[0].id;
  const controller = new AbortController();
  const maxMin = Number(bot.program?.durata_max_min) || 30;
  const timer = setTimeout(() => controller.abort(new Error(`a depășit ${maxMin} minute`)), maxMin * 60_000);
  running.set(botId, { rulareId, controller, timer });
  events.emit("ev", { tip: "pornit", bot_id: botId, rulare_id: rulareId });
  log(`${botId} #${rulareId} pornit (${declansat})`);

  execute(bot, impl, rulareId, controller).finally(() => {
    clearTimeout(timer);
    running.delete(botId);
  });
  return rulareId;
}

async function execute(bot, impl, rulareId, controller) {
  const signal = controller.signal;
  const progres = (text) => {
    events.emit("ev", { tip: "progres", bot_id: bot.id, rulare_id: rulareId, text });
    setRun(rulareId, { progres: text }).catch(() => {});
  };
  const ask = async ({ tools: useTools, ...opts }) =>
    brain.ask({ ...opts, model: bot.model, signal, server: useTools ? await tools.server() : null });

  try {
    const res = await impl.run({ bot, signal, progres, ask });
    if (signal.aborted) throw signal.reason || new Error("oprit");
    const report = res.structured || { rezumat: res.text.slice(0, 200), constatari: [], text_vorbit: res.text };
    progres("citesc raportul cu voce");
    let audio = null;
    try {
      const v = { ...DEFAULT_VOICE, ...(bot.voce || {}) };
      audio = await voce.tts(report.text_vorbit || report.rezumat, { voce: v.id, viteza: v.viteza, prefix: `r${rulareId}` });
    } catch (e) {
      log(`${bot.id} #${rulareId}: vocea nu a mers: ${e.message}`);
    }
    await setRun(rulareId, {
      status: "gata",
      progres: null,
      rezumat: report.rezumat,
      constatari: JSON.stringify(report.constatari || []),
      text_vorbit: report.text_vorbit,
      audio,
      cost_usd: res.costUsd,
      sfarsit: new Date(),
    });
    events.emit("ev", { tip: "gata", bot_id: bot.id, rulare_id: rulareId });
    log(`${bot.id} #${rulareId} gata: ${(report.constatari || []).length} constatări`);
    await push
      .notify({ title: bot.nume, body: report.rezumat || "Raport nou", url: `/boti.html?rulare=${rulareId}`, tag: `bot-${bot.id}` })
      .catch((e) => log(`push: ${e.message}`));
  } catch (e) {
    const stopped = signal.aborted;
    const msg = stopped ? (signal.reason?.message || "oprit de tine") : e.message;
    await setRun(rulareId, { status: stopped ? "oprit" : "eroare", eroare: msg, progres: null, sfarsit: new Date() }).catch(() => {});
    events.emit("ev", { tip: stopped ? "oprit" : "eroare", bot_id: bot.id, rulare_id: rulareId, text: msg });
    log(`${bot.id} #${rulareId} ${stopped ? "oprit" : "eroare"}: ${msg}`);
    if (!stopped) await push.notify({ title: `${bot.nume}: eroare`, body: msg.slice(0, 150), url: `/boti.html?rulare=${rulareId}`, tag: `bot-${bot.id}` }).catch(() => {});
  }
}

function stop(botId, reason = "oprit de tine") {
  const r = running.get(botId);
  if (!r) return false;
  r.controller.abort(new Error(reason));
  return true;
}

function isRunning(botId) {
  return running.has(botId);
}

/** Rulările rămase „ruleaza” după un restart al containerului. */
async function cleanupStale() {
  await query(`UPDATE boti_rulari SET status = 'oprit', eroare = 'serviciul a fost repornit', progres = NULL, sfarsit = now() WHERE status = 'ruleaza'`);
}

// ---------- conversația ----------

async function conversation({ botId, rulareId = null, conversatieId = null }) {
  if (conversatieId) {
    const { rows } = await query(`SELECT * FROM boti_conversatii WHERE id = $1 AND bot_id = $2`, [conversatieId, botId]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await query(`INSERT INTO boti_conversatii (bot_id, rulare_id) VALUES ($1, $2) RETURNING *`, [botId, rulareId]);
  return rows[0];
}

/** Tu spui `text` → botul răspunde (text + MP3). */
async function reply({ botId, text, rulareId = null, conversatieId = null, audioEu = null }) {
  const bot = await getBot(botId);
  const conv = await conversation({ botId, rulareId, conversatieId });
  await query(`INSERT INTO boti_mesaje (conversatie_id, rol, text, audio) VALUES ($1, 'eu', $2, $3)`, [conv.id, text, audioEu]);

  let prompt = text;
  if (!conv.session_id) {
    let context = "Nu discutăm despre un raport anume.";
    const rid = conv.rulare_id;
    if (rid) {
      const { rows } = await query(`SELECT inceput, rezumat, constatari, text_vorbit FROM boti_rulari WHERE id = $1`, [rid]);
      if (rows[0]) context = `Raportul tău din ${new Date(rows[0].inceput).toLocaleString("ro-RO")}:\n${rows[0].text_vorbit}\nConstatări: ${JSON.stringify(rows[0].constatari)}`;
    }
    prompt = `${context}\n\nProprietarul îți spune (transcris din voce, pot fi mici greșeli de transcriere): ${text}`;
  }

  const system = `${systemPrompt(bot, `Acum vorbești cu proprietarul despre ce ai găsit. Răspunzi scurt (2–6 propoziții), ca într-o discuție la telefon. Dacă îți cere ceva de verificat, folosește uneltele și spune ce ai găsit. ${bot.descriere || ""}`)}`;
  const res = await brain.ask({ system, prompt, model: bot.model, server: await tools.server(), resume: conv.session_id, maxTurns: 15 });
  const answer = res.text || "Nu am un răspuns acum.";
  let audio = null;
  try {
    const v = { ...DEFAULT_VOICE, ...(bot.voce || {}) };
    audio = await voce.tts(answer, { voce: v.id, viteza: v.viteza, prefix: `c${conv.id}` });
  } catch (e) {
    log(`${botId} conversația ${conv.id}: vocea nu a mers: ${e.message}`);
  }
  await query(`INSERT INTO boti_mesaje (conversatie_id, rol, text, audio) VALUES ($1, 'bot', $2, $3)`, [conv.id, answer, audio]);
  await query(`UPDATE boti_conversatii SET session_id = $2, updated_at = now() WHERE id = $1`, [conv.id, res.sessionId || conv.session_id]);
  return { conversatie_id: conv.id, raspuns: answer, audio };
}

module.exports = { BOTS, events, start, stop, isRunning, cleanupStale, reply, getBot };
