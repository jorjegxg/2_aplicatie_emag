/**
 * Serviciul `emag-cod` (pe PC, systemd --user, NU în Docker): API-ul paginii Claude Code (/cod.html).
 * Pornește sesiuni Claude Code în repo, cu contul tău din ~/.claude, și îți vorbește prin serviciul `voce`.
 *
 * Front-ul (nginx din Docker) trimite /api/cod/ aici prin host.docker.internal:3200.
 * Login: același cookie ca restul aplicației (APP_PASSWORD) — fără parolă serviciul nu pornește,
 * pentru că poate modifica fișiere și rula comenzi pe PC.
 */
const fs = require("fs");
const path = require("path");

// .env din rădăcina repo-ului; ce e deja în mediu (systemd) are prioritate.
(function loadEnv() {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    const eq = t.indexOf("=");
    if (!t || t.startsWith("#") || eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] == null) process.env[key] = val;
  }
})();
// Baza din Docker e pe 5433 pe host (DATABASE_URL din .env e pentru alt Postgres) — o folosesc doar notificările.
process.env.DATABASE_URL =
  process.env.COD_DATABASE_URL ||
  `postgres://${process.env.POSTGRES_USER || "emag"}:${process.env.POSTGRES_PASSWORD || "emag"}@127.0.0.1:5433/${process.env.POSTGRES_DB || "emag"}`;

const express = require("express");
const multer = require("multer");
const { requireAppAuth, isAuthEnabled } = require("../backend/app-auth");
const ses = require("./sesiune");
const voce = require("./voce");

const PORT = Number(process.env.COD_PORT || 3200);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

if (!isAuthEnabled()) {
  console.error("emag-cod: APP_PASSWORD lipsește din .env — fără parolă nu pornesc (pagina poate rula comenzi pe PC).");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Doar de pe PC sau din rețelele Docker (nginx-ul din front); nu din LAN / Tailscale direct.
app.use((req, res, next) => {
  const ip = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1" || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return next();
  res.status(403).json({ error: "Interzis" });
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const r = express.Router();

app.get("/api/cod/health", (req, res) => res.json({ ok: true }));
app.use(requireAppAuth);

// ---------- sesiuni ----------

r.get("/sesiuni", wrap(async (req, res) => {
  res.json({ sesiuni: await ses.lista(Math.max(1, Math.min(200, Number(req.query.limit) || 40))), setari: voce.setari(), moduri: ses.MODURI });
}));

r.get("/sesiuni/:id", wrap(async (req, res) => res.json(await ses.istoric(req.params.id))));

function textOf(req) {
  const text = String(req.body?.text || "").trim();
  if (!text) {
    const err = new Error("Mesaj gol");
    err.status = 400;
    throw err;
  }
  return text;
}

r.post("/sesiuni", wrap(async (req, res) => {
  res.json(await ses.sesiuneNoua(textOf(req), { mod: req.body?.mod, model: req.body?.model }));
}));

r.post("/sesiuni/:id/mesaj", wrap(async (req, res) => res.json(await ses.mesaj(req.params.id, textOf(req)))));

// Audio → text → mesaj (sau răspuns la aprobarea în așteptare). id = "nou" pornește o sesiune nouă.
r.post("/sesiuni/:id/vorbeste", upload.single("audio"), wrap(async (req, res) => {
  if (!req.file?.buffer?.length) return res.status(400).json({ error: "Lipsește înregistrarea (câmpul audio)" });
  const heard = await voce.stt(req.file.buffer, { filename: req.file.originalname || "voce.webm", mimetype: req.file.mimetype });
  const text = String(heard.text || "").trim();
  if (!text) return res.status(422).json({ error: "Nu am înțeles nimic din înregistrare", transcriere: "" });
  const out =
    req.params.id === "nou"
      ? await ses.sesiuneNoua(text, { mod: req.body?.mod, model: req.body?.model })
      : await ses.mesaj(req.params.id, text);
  res.json({ transcriere: text, ...out });
}));

r.post("/sesiuni/:id/mod", wrap(async (req, res) => res.json(await ses.setMod(req.params.id, req.body?.mod))));
r.post("/sesiuni/:id/model", wrap(async (req, res) => res.json(await ses.setModel(req.params.id, req.body?.model))));
r.post("/sesiuni/:id/opreste", wrap(async (req, res) => res.json(await ses.opreste(req.params.id))));
r.post("/sesiuni/:id/anuleaza/:uuid", wrap(async (req, res) => res.json(await ses.anuleaza(req.params.id, req.params.uuid))));

r.post("/cereri/:rid", (req, res) => res.json(ses.raspunde(req.params.rid, req.body || {})));

// ---------- voce ----------

r.get("/voci", wrap(async (req, res) => res.json(await voce.voci())));

r.put("/setari", (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.voce) patch.voce = String(b.voce);
  if (b.viteza != null) patch.viteza = Math.max(0.6, Math.min(1.6, Number(b.viteza) || 1));
  if (ses.MODURI.includes(b.mod)) patch.mod = b.mod;
  if (b.model != null) patch.model = ["", "haiku", "sonnet", "opus"].includes(b.model) ? b.model : "";
  res.json(voce.saveSetari(patch));
});

// Textul vorbit → MP3 (pentru rezumatele din istoric, făcute la cerere).
r.post("/voce", wrap(async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Text gol" });
  res.json({ audio: await voce.tts(text) });
}));

r.get("/audio/:file", (req, res) => {
  const p = voce.audioPath(req.params.file);
  if (!p) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(p);
});

// ---------- evenimente (SSE) ----------

r.get("/evenimente", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": ok\n\n");
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  ses.events.on("ev", send);
  req.on("close", () => {
    clearInterval(ping);
    ses.events.off("ev", send);
  });
});

app.use("/api/cod", r);

app.use((err, req, res, next) => {
  const status = err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Eroare" });
});

const server = app.listen(PORT, "0.0.0.0", () => console.log(`emag-cod: ascult pe ${PORT}, repo ${ses.REPO}`));
const stop = () => {
  ses.inchideTot();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
