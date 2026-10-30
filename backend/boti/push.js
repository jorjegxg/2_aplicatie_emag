/** Notificări Web Push în browser (pagina Boți). Cheile VAPID stau în data/vapid-keys.json. */
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const { query } = require("../pg");

const KEYS_FILE = path.join(__dirname, "..", "data", "vapid-keys.json");
let ready = false;

function keys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  if (!fs.existsSync(KEYS_FILE)) {
    const k = webpush.generateVAPIDKeys();
    fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ ...k, createdAt: new Date().toISOString() }, null, 2));
  }
  return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
}

function setup() {
  if (ready) return;
  const k = keys();
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@localhost", k.publicKey, k.privateKey);
  ready = true;
}

function publicKey() {
  return keys().publicKey;
}

async function subscribe(sub, userAgent) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    const err = new Error("abonare invalidă");
    err.status = 400;
    throw err;
  }
  await query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent, updated_at = now()`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(userAgent || "").slice(0, 300)]
  );
}

async function unsubscribe(endpoint) {
  await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [String(endpoint || "")]);
}

/** { title, body, url, tag } către toate browserele abonate; abonările moarte se șterg. */
async function notify(payload) {
  setup();
  const { rows } = await query(`SELECT endpoint, p256dh, auth FROM push_subscriptions`);
  let sent = 0;
  for (const r of rows) {
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, JSON.stringify(payload), { TTL: 6 * 3600 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await unsubscribe(r.endpoint);
      else console.log(`push: ${e.statusCode || ""} ${e.message}`);
    }
  }
  return sent;
}

module.exports = { publicKey, subscribe, unsubscribe, notify };
