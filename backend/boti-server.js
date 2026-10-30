/**
 * Serviciul `boti` (docker compose): API-ul paginii Boți + programul boților.
 * Boții doar citesc din Base / eMAG / Trendyol și îți spun cu voce ce au găsit; le poți răspunde
 * cu vocea (POST /api/boti/:id/vorbeste). Login: același cookie ca restul aplicației (APP_PASSWORD).
 */
const express = require("express");
const multer = require("multer");
const { ensureSchema, query } = require("./pg");
const { requireAppAuth } = require("./app-auth");
const runner = require("./boti/runner");
const brain = require("./boti/brain");
const voce = require("./boti/voce-client");
const push = require("./boti/push");
const browser = require("./boti/browser");
const { startScheduler, nextRunText } = require("./boti/scheduler");

const PORT = Number(process.env.PORT || 3100);
const MODELS = ["haiku", "sonnet", "opus"];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const r = express.Router();

// Public (fără login), înaintea verificării sesiunii.
app.get("/api/boti/health", wrap(async (req, res) => {
  res.json({ ok: true, voce: await voce.health(), creier: Boolean(await brain.account()) });
}));

app.use(requireAppAuth);

// ---------- boți ----------

async function botView(b) {
  const { rows } = await query(
    `SELECT id, status, rezumat, inceput, sfarsit, progres, eroare,
            (SELECT count(*)::int FROM boti_rulari x WHERE x.bot_id = $1 AND x.status = 'gata' AND NOT x.citit) AS necitite
       FROM boti_rulari WHERE bot_id = $1 ORDER BY inceput DESC LIMIT 1`,
    [b.id]
  );
  return { ...b, ruleaza: runner.isRunning(b.id), program_text: nextRunText(b.program || {}, b.activ), ultima: rows[0] || null, necitite: rows[0]?.necitite || 0 };
}

r.get("/", wrap(async (req, res) => {
  const { rows } = await query(`SELECT * FROM boti ORDER BY CASE id WHEN 'discrepante' THEN 1 WHEN 'poze-preturi' THEN 2 ELSE 3 END`);
  res.json({ boti: await Promise.all(rows.map(botView)) });
}));

function cleanProgram(p = {}) {
  const hhmm = (v) => (v == null || v === "" ? null : /^\d{1,2}:\d{2}$/.test(String(v)) ? String(v).padStart(5, "0") : undefined);
  const out = {
    zile: (Array.isArray(p.zile) ? p.zile : []).map(Number).filter((z) => z >= 1 && z <= 7),
    ora_start: hhmm(p.ora_start) ?? "00:00",
    ora_stop: hhmm(p.ora_stop) ?? null,
    interval_min: Math.max(0, Math.min(24 * 60, Number(p.interval_min) || 0)),
    durata_max_min: Math.max(1, Math.min(240, Number(p.durata_max_min) || 20)),
  };
  if (!out.zile.length) out.zile = [1, 2, 3, 4, 5, 6, 7];
  return out;
}

r.patch("/bot/:id", wrap(async (req, res) => {
  const bot = await runner.getBot(req.params.id);
  const b = req.body || {};
  const next = {
    activ: b.activ == null ? bot.activ : Boolean(b.activ),
    program: b.program ? cleanProgram({ ...bot.program, ...b.program }) : bot.program,
    voce: b.voce ? { id: String(b.voce.id || bot.voce?.id || ""), viteza: Math.max(0.6, Math.min(1.6, Number(b.voce.viteza) || 1)) } : bot.voce,
    model: MODELS.includes(b.model) ? b.model : bot.model,
    setari: b.setari ? { ...bot.setari, ...b.setari } : bot.setari,
  };
  if (next.setari.max_produse != null) next.setari.max_produse = Math.max(1, Math.min(100, Number(next.setari.max_produse) || 5));
  const { rows } = await query(
    `UPDATE boti SET activ = $2, program = $3, voce = $4, model = $5, setari = $6, updated_at = now() WHERE id = $1 RETURNING *`,
    [bot.id, next.activ, JSON.stringify(next.program), JSON.stringify(next.voce), next.model, JSON.stringify(next.setari)]
  );
  if (!next.activ && runner.isRunning(bot.id)) runner.stop(bot.id, "botul a fost oprit");
  runner.events.emit("ev", { tip: "setari", bot_id: bot.id });
  res.json(await botView(rows[0]));
}));

r.post("/bot/:id/porneste", wrap(async (req, res) => {
  await runner.getBot(req.params.id);
  res.json({ rulare_id: await runner.start(req.params.id, { declansat: "manual" }) });
}));

r.post("/bot/:id/opreste", (req, res) => {
  res.json({ oprit: runner.stop(req.params.id) });
});

r.get("/bot/:id/rulari", wrap(async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  const { rows } = await query(
    `SELECT id, bot_id, declansat, status, progres, eroare, rezumat, jsonb_array_length(constatari) AS nr_constatari,
            audio, citit, inceput, sfarsit, cost_usd
       FROM boti_rulari WHERE bot_id = $1 ORDER BY inceput DESC LIMIT $2`,
    [req.params.id, limit]
  );
  res.json({ rulari: rows });
}));

// ---------- rapoarte ----------

r.get("/rulari/:rid", wrap(async (req, res) => {
  const { rows } = await query(`SELECT r.*, b.nume AS bot_nume FROM boti_rulari r JOIN boti b ON b.id = r.bot_id WHERE r.id = $1`, [Number(req.params.rid)]);
  if (!rows[0]) return res.status(404).json({ error: "Raportul nu există" });
  const { rows: conv } = await query(`SELECT id FROM boti_conversatii WHERE rulare_id = $1 ORDER BY id DESC LIMIT 1`, [rows[0].id]);
  res.json({ ...rows[0], conversatie_id: conv[0]?.id || null });
}));

r.post("/rulari/:rid/citit", wrap(async (req, res) => {
  await query(`UPDATE boti_rulari SET citit = true WHERE id = $1`, [Number(req.params.rid)]);
  res.json({ ok: true });
}));

// ---------- conversație ----------

r.post("/bot/:id/vorbeste", upload.single("audio"), wrap(async (req, res) => {
  if (!req.file?.buffer?.length) return res.status(400).json({ error: "Lipsește înregistrarea (câmpul audio)" });
  const heard = await voce.stt(req.file.buffer, { filename: req.file.originalname || "voce.webm", mimetype: req.file.mimetype });
  const text = String(heard.text || "").trim();
  if (!text) return res.status(422).json({ error: "Nu am înțeles nimic din înregistrare", transcriere: "" });
  const out = await runner.reply({
    botId: req.params.id,
    text,
    rulareId: Number(req.body.rulare_id) || null,
    conversatieId: Number(req.body.conversatie_id) || null,
  });
  res.json({ transcriere: text, ...out });
}));

r.post("/bot/:id/mesaj", wrap(async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Mesaj gol" });
  const out = await runner.reply({
    botId: req.params.id,
    text,
    rulareId: Number(req.body.rulare_id) || null,
    conversatieId: Number(req.body.conversatie_id) || null,
  });
  res.json(out);
}));

r.get("/conversatii/:cid", wrap(async (req, res) => {
  const { rows: conv } = await query(`SELECT id, bot_id, rulare_id, created_at FROM boti_conversatii WHERE id = $1`, [Number(req.params.cid)]);
  if (!conv[0]) return res.status(404).json({ error: "Conversația nu există" });
  const { rows } = await query(`SELECT id, rol, text, audio, created_at FROM boti_mesaje WHERE conversatie_id = $1 ORDER BY id`, [conv[0].id]);
  res.json({ ...conv[0], mesaje: rows });
}));

// ---------- voci ----------

r.get("/voci", wrap(async (req, res) => res.json(await voce.voci())));

r.post("/voci/proba", wrap(async (req, res) => {
  const text =
    String(req.body?.text || "").trim().slice(0, 600) ||
    "Bună! Am verificat cincizeci și opt de produse. Pe eMAG Ungaria, perna lombară are prețul cu 30 la sută mai mic decât în Base, iar pe Trendyol îi lipsesc două poze. Vrei detalii?";
  const audio = await voce.tts(text, { voce: req.body?.voce, viteza: Number(req.body?.viteza) || 1, prefix: "proba" });
  res.json({ audio });
}));

r.get("/audio/:file", (req, res) => {
  const p = voce.audioPath(req.params.file);
  if (!p) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(p);
});

// ---------- cont Claude ----------

r.get("/setari/creier", wrap(async (req, res) => {
  res.json(req.query.verifica ? await brain.status() : await brain.account().then((a) => (a ? { configurat: true, tip: a.tip, sursa: a.sursa, nume: a.nume || null, token: `…${a.token.slice(-6)}` } : { configurat: false })));
}));

r.put("/setari/creier", wrap(async (req, res) => {
  await brain.saveAccount({ token: req.body?.token, nume: req.body?.nume });
  res.json(await brain.status());
}));

// ---------- notificări ----------

r.get("/push/cheie", (req, res) => res.json({ cheie: push.publicKey() }));
r.post("/push/abonare", wrap(async (req, res) => {
  await push.subscribe(req.body, req.headers["user-agent"]);
  res.json({ ok: true });
}));
r.post("/push/dezabonare", wrap(async (req, res) => {
  await push.unsubscribe(req.body?.endpoint);
  res.json({ ok: true });
}));
r.post("/push/test", wrap(async (req, res) => {
  res.json({ trimise: await push.notify({ title: "Boți", body: "Notificările merg.", url: "/boti.html", tag: "test" }) });
}));

// ---------- evenimente (SSE) ----------

r.get("/evenimente", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": ok\n\n");
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  runner.events.on("ev", send);
  req.on("close", () => {
    clearInterval(ping);
    runner.events.off("ev", send);
  });
});

app.use("/api/boti", r);

app.use((err, req, res, next) => {
  const status = err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Eroare" });
});

(async () => {
  await ensureSchema();
  await runner.cleanupStale();
  startScheduler();
  const server = app.listen(PORT, () => console.log(`boți: ascult pe ${PORT}`));
  const stop = async () => {
    server.close();
    await browser.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
