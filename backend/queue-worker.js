/**
 * Serviciul `queue` (docker compose): verifică periodic coada emag_push_queue și trimite în Base
 * ce a devenit posibil (vezi emag-queue.js). Nimic nu mai pleacă direct pe eMAG.
 *   BASE_SEND=1             trimite pe bune; altfel doar scrie în log ce ar trimite
 *   QUEUE_INTERVAL_SEC=300  cât de des verifică
 */
const { ensureSchema } = require("./pg");
const { processOnce } = require("./emag-queue");
const { sendEnabled } = require("./base-client");

const SEND = sendEnabled();
const INTERVAL_MS = Math.max(60, Number(process.env.QUEUE_INTERVAL_SEC || 300)) * 1000;
let stopping = false;
let timer = null;

const log = (s) => console.log(`${new Date().toISOString().slice(0, 16).replace("T", " ")} ${s}`);

async function tick() {
  try {
    const { open } = await processOnce({ send: SEND, log });
    if (!open) log("coada e goală");
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
  log(`pornit: ${SEND ? "TRIMITE în Base" : "doar verifică (BASE_SEND=0)"}, la ${INTERVAL_MS / 1000}s`);
  await tick();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
