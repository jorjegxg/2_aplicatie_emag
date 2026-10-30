/**
 * Serviciul `validari` (docker compose): verifică periodic statusul de validare al ofertelor eMAG
 * pe RO/HU/BG și anunță când poți pune produsul pe platforma următoare (vezi emag-validari.js).
 *   VALIDARI_INTERVAL_SEC=300                cât de des verifică
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID    unde trimite mesajele (fără ele doar scrie în log)
 */
const { ensureSchema } = require("./pg");
const { processOnce, notifyTelegram, telegramConfigured, LABEL } = require("./emag-validari");

const INTERVAL_MS = Math.max(60, Number(process.env.VALIDARI_INTERVAL_SEC || 300)) * 1000;
// După atâtea citiri picate la rând pe o platformă (de ex. „Invalid vendor ip”), trimite un singur mesaj.
const FAIL_ALERT_AFTER = 3;
const failures = {};
let stopping = false;
let timer = null;

const log = (s) => console.log(`${new Date().toISOString().slice(0, 16).replace("T", " ")} ${s}`);

async function alert(text) {
  log(text);
  try {
    await notifyTelegram(text);
  } catch (e) {
    log(`Telegram: ${e.message}`);
  }
}

async function tick() {
  try {
    const res = await processOnce({ log });
    if (res.skipped) {
      log("o altă verificare rulează deja, o sar");
    } else {
      const parts = [];
      for (const [p, r] of Object.entries(res.platforms)) {
        const n = failures[p] || 0;
        if (r.ok) {
          parts.push(`${LABEL[p]} ${r.matched}/${r.offers}`);
          if (n >= FAIL_ALERT_AFTER) await alert(`✅ eMAG ${LABEL[p]} răspunde din nou`);
          failures[p] = 0;
        } else {
          parts.push(`${LABEL[p]} eroare`);
          failures[p] = n + 1;
          if (failures[p] === FAIL_ALERT_AFTER) {
            await alert(`⚠️ eMAG ${LABEL[p]} nu răspunde de ${FAIL_ALERT_AFTER} verificări: ${r.error}`);
          }
        }
      }
      log(`verificat (oferte legate/citite): ${parts.join(", ")}; ${res.events.length} schimbări`);
    }
  } catch (e) {
    log(`eroare la verificare: ${e.stack || e.message}`);
  }
  if (!stopping) timer = setTimeout(tick, INTERVAL_MS);
}

function stop() {
  stopping = true;
  if (timer) clearTimeout(timer);
  log("oprit");
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

(async () => {
  await ensureSchema();
  log(`pornit: verific la ${INTERVAL_MS / 1000}s, Telegram ${telegramConfigured() ? "activ" : "neconfigurat (doar log)"}`);
  await tick();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
