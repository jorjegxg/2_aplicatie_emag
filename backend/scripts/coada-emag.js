#!/usr/bin/env node
/**
 * Coada de trimiteri amânate (serviciul `queue` le trimite în Base când devin posibile).
 * Rulează în container:  docker exec emag-queue node scripts/coada-emag.js <comanda> ...
 *
 *   list [--toate]                    intrările deschise (și cele din ultima zi)
 *   add --produs 45 --platforma bg    trimite pozele din aplicație pe BG
 *       [--fara-poze]                 nu trimite pozele
 *       [--titlu "..."] [--titlu-app] titlu explicit / din aplicație (doar RO)
 *       [--descriere-fisier f.txt] [--descriere-app]   descriere text simplu / din aplicație (doar RO)
 *       [--caracteristici '{"5401":"Negru","7235":["a","b"]}']
 *       [--dupa 12]                   abia după ce intrarea #12 s-a terminat
 *       [--la "2026-10-24 09:00"]     nu mai devreme de (ora României) / [--in 2h] (m, h, d)
 *       [--inlocuieste-blocat]        retrimite chiar dacă platforma lui e în validare (actualizare blocată)
 *       [--nota "..."]
 *   add-json fisier.json              listă de intrări; câmpul "dupa_precedenta": true leagă de intrarea anterioară
 *   cancel <id> | retry <id>
 *   run-once [--trimite]              o trecere acum (implicit doar arată ce ar trimite; trimite doar cu BASE_SEND=1)
 */
const fs = require("fs");
const path = require("path");
const { ensureSchema, endPool } = require("../pg");
const q = require("../emag-queue");

function arg(list, name) {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
}

/** "2026-10-24 09:00" în ora României -> Date (UTC). Acceptă și ISO cu fus orar. */
function parseLocal(s) {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return new Date(s);
  const m = String(s).match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)$/);
  if (!m) throw new Error(`dată invalidă: ${s} (folosește "AAAA-LL-ZZ HH:MM")`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const tz = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bucharest", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(guess))
    .reduce((o, p) => ((o[p.type] = p.value), o), {});
  const shown = Date.UTC(+tz.year, +tz.month - 1, +tz.day, +tz.hour, +tz.minute);
  return new Date(guess - (shown - guess));
}

function parseIn(s) {
  const m = String(s).match(/^(\d+)\s*([mhd])$/);
  if (!m) throw new Error(`durată invalidă: ${s} (ex. 30m, 2h, 1d)`);
  return new Date(Date.now() + Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]]);
}

function fromJson(o) {
  return {
    product_id: o.produs ?? o.product_id,
    platform: o.platforma ?? o.platform,
    send_images: o.poze !== false,
    name: o.titlu ?? null,
    description: o.descriere ?? (o.descriere_fisier ? fs.readFileSync(o.descriere_fisier, "utf8") : null),
    name_from_app: Boolean(o.titlu_app),
    description_from_app: Boolean(o.descriere_app),
    characteristics: o.caracteristici || null,
    not_before: o.la ? parseLocal(o.la) : o.in ? parseIn(o.in) : null,
    after_id: o.dupa ?? null,
    replace_pending: Boolean(o.inlocuieste_blocat),
    note: o.nota ?? null,
  };
}

const fmt = (d) => (d ? new Date(d).toLocaleString("ro-RO", { timeZone: "Europe/Bucharest", dateStyle: "short", timeStyle: "short" }) : "-");

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  await ensureSchema();
  if (cmd === "list") {
    const rows = await q.listItems({ all: rest.includes("--toate") });
    if (!rows.length) return console.log("coada e goală");
    for (const r of rows) {
      const what = [r.send_images ? "poze" : null, r.name || r.name_from_app ? "titlu" : null, r.description || r.description_from_app ? "descriere" : null, r.characteristics ? "caracteristici" : null].filter(Boolean).join("+");
      console.log(
        `#${r.id} ${r.status.padEnd(9)} ${String(r.product_id).padStart(3)} ${String(r.cod_produs).padEnd(16)} ${r.platform.toUpperCase()} ${what.padEnd(28)}` +
          ` de la ${fmt(r.not_before)}${r.after_id ? ` după #${r.after_id}` : ""} | încercări ${r.attempts}/${r.max_attempts}` +
          `${r.sent_at ? ` | trimis ${fmt(r.sent_at)}` : ""} | ${r.last_message || ""}${r.note ? ` | ${r.note}` : ""}`
      );
    }
  } else if (cmd === "add") {
    const o = {
      produs: Number(arg(rest, "--produs")),
      platforma: arg(rest, "--platforma"),
      poze: !rest.includes("--fara-poze"),
      titlu: arg(rest, "--titlu"),
      titlu_app: rest.includes("--titlu-app"),
      descriere_fisier: arg(rest, "--descriere-fisier"),
      descriere_app: rest.includes("--descriere-app"),
      caracteristici: arg(rest, "--caracteristici") ? JSON.parse(arg(rest, "--caracteristici")) : null,
      dupa: arg(rest, "--dupa") ? Number(arg(rest, "--dupa")) : null,
      la: arg(rest, "--la"),
      in: arg(rest, "--in"),
      inlocuieste_blocat: rest.includes("--inlocuieste-blocat"),
      nota: arg(rest, "--nota"),
    };
    const row = await q.addItem(fromJson(o));
    console.log(`adăugat #${row.id}: produs ${row.product_id} ${row.platform.toUpperCase()}, de la ${fmt(row.not_before)}${row.after_id ? `, după #${row.after_id}` : ""}`);
  } else if (cmd === "add-json") {
    const file = rest[0];
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    const dir = path.dirname(path.resolve(file));
    let prev = null;
    for (const o of list) {
      if (o.descriere_fisier && !path.isAbsolute(o.descriere_fisier)) o.descriere_fisier = path.join(dir, o.descriere_fisier);
      if (o.dupa_precedenta && prev) o.dupa = prev.id;
      const row = await q.addItem(fromJson(o));
      console.log(`adăugat #${row.id}: produs ${row.product_id} ${row.platform.toUpperCase()}${row.after_id ? `, după #${row.after_id}` : ""}${row.note ? ` (${row.note})` : ""}`);
      prev = row;
    }
  } else if (cmd === "cancel") {
    await q.cancelItem(rest[0]);
    console.log(`#${rest[0]} anulat`);
  } else if (cmd === "retry") {
    await q.retryItem(rest[0]);
    console.log(`#${rest[0]} repus în coadă`);
  } else if (cmd === "run-once") {
    await q.processOnce({ send: rest.includes("--trimite"), log: console.log });
  } else {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]);
  }
}

main()
  .then(() => endPool())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
