/**
 * Programul boților, după ora României. Per bot (coloana `program`):
 *   zile            [1..7], luni = 1
 *   ora_start       "HH:MM" de când are voie să pornească
 *   ora_stop        "HH:MM" sau null; la ora asta se și oprește dacă încă rulează
 *   interval_min    0 = o dată pe zi după ora_start; altfel din N în N minute în fereastră
 *   durata_max_min  cât are voie să ruleze o dată (vezi runner.start)
 */
const { query } = require("../pg");
const runner = require("./runner");

const TICK_MS = 30_000;
const TZ = "Europe/Bucharest";
let timer = null;

/** { zi: 1..7, min: minute de la miezul nopții, data: "YYYY-MM-DD" } în ora României. */
function localNow(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  const zi = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  return { zi, min: Number(parts.hour) * 60 + Number(parts.minute), data: `${parts.year}-${parts.month}-${parts.day}` };
}

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Trebuie să pornească acum? `last` = { inceput } ultima rulare, `lastToday` = ultima rulare din program azi. */
function due(program, now, last, lastProgramToday) {
  const zile = Array.isArray(program.zile) && program.zile.length ? program.zile.map(Number) : [1, 2, 3, 4, 5, 6, 7];
  if (!zile.includes(now.zi)) return false;
  const start = toMin(program.ora_start) ?? 0;
  const stop = toMin(program.ora_stop);
  if (now.min < start) return false;
  if (stop != null && now.min >= stop) return false;
  const interval = Number(program.interval_min) || 0;
  if (!interval) return !lastProgramToday;
  if (!last) return true;
  return Date.now() - new Date(last.inceput).getTime() >= interval * 60_000;
}

function pastStop(program, now) {
  const stop = toMin(program.ora_stop);
  return stop != null && now.min >= stop;
}

async function tick() {
  try {
    const now = localNow();
    const { rows: bots } = await query(`SELECT id, program, activ FROM boti`);
    for (const bot of bots) {
      const program = bot.program || {};
      if (runner.isRunning(bot.id)) {
        if (pastStop(program, now)) runner.stop(bot.id, `ora de oprire ${program.ora_stop}`);
        continue;
      }
      if (!bot.activ) continue;
      const { rows } = await query(
        `SELECT inceput, declansat, (inceput AT TIME ZONE '${TZ}')::date = $2::date AS azi
           FROM boti_rulari WHERE bot_id = $1 ORDER BY inceput DESC LIMIT 20`,
        [bot.id, now.data]
      );
      const last = rows[0] || null;
      const startMin = toMin(program.ora_start) ?? 0;
      // „o dată pe zi”: o rulare din program pornită azi după ora_start ajunge.
      const lastProgramToday = rows.some((r) => r.azi && r.declansat === "program" && localNow(new Date(r.inceput)).min >= startMin);
      if (due(program, now, last, lastProgramToday)) await runner.start(bot.id, { declansat: "program" });
    }
  } catch (e) {
    console.log(`program: ${e.message}`);
  }
}

function startScheduler() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 5_000);
}

/** Când pornește următoarea dată (text, pentru pagină). */
function nextRunText(program, activ) {
  if (!activ) return "oprit";
  const zile = (program.zile || []).length === 7 || !(program.zile || []).length ? "zilnic" : `zilele ${program.zile.join(", ")}`;
  const interval = Number(program.interval_min) || 0;
  const fereastra = program.ora_stop ? `${program.ora_start}–${program.ora_stop}` : `de la ${program.ora_start}`;
  return interval ? `${zile}, ${fereastra}, din ${interval} în ${interval} min` : `${zile}, o dată ${fereastra}`;
}

module.exports = { startScheduler, localNow, due, nextRunText };
