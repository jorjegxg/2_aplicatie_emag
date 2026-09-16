/**
 * Web Push pentru comenzi eMAG noi (bara de notificări pe telefon / desktop).
 * VAPID: din env sau generate automat în data/vapid-keys.json.
 */
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const { query, ensureSchema } = require("./pg");

const VAPID_PATH = path.join(__dirname, "data", "vapid-keys.json");
const CONTACT =
  process.env.VAPID_SUBJECT || "mailto:admin@localhost";

let ready = null;
let publicKey = "";

function ensureDataDir() {
  const dir = path.dirname(VAPID_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadOrCreateVapid() {
  const fromEnv =
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? {
          publicKey: process.env.VAPID_PUBLIC_KEY.trim(),
          privateKey: process.env.VAPID_PRIVATE_KEY.trim(),
        }
      : null;

  if (fromEnv) return fromEnv;

  ensureDataDir();
  if (fs.existsSync(VAPID_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(VAPID_PATH, "utf8"));
      if (raw?.publicKey && raw?.privateKey) {
        return { publicKey: raw.publicKey, privateKey: raw.privateKey };
      }
    } catch {
      /* regenerate below */
    }
  }

  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(
    VAPID_PATH,
    JSON.stringify(
      {
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  console.log("[push] VAPID keys generate în data/vapid-keys.json");
  return keys;
}

async function initPush() {
  if (ready) return ready;
  ready = (async () => {
    const keys = loadOrCreateVapid();
    publicKey = keys.publicKey;
    webpush.setVapidDetails(CONTACT, keys.publicKey, keys.privateKey);
    await ensureSchema();
    return { publicKey };
  })();
  try {
    return await ready;
  } catch (err) {
    ready = null;
    throw err;
  }
}

function getPublicKey() {
  return publicKey;
}

function normalizeSubscription(body) {
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  const p256dh = body?.keys?.p256dh || body?.p256dh;
  const auth = body?.keys?.auth || body?.auth;
  if (!endpoint || !p256dh || !auth) {
    const err = new Error("Subscription invalidă (endpoint / keys lipsă)");
    err.status = 400;
    throw err;
  }
  return {
    endpoint,
    keys: { p256dh: String(p256dh), auth: String(auth) },
  };
}

async function saveSubscription(subscription, userAgent) {
  await initPush();
  const sub = normalizeSubscription(subscription);
  await query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (endpoint) DO UPDATE SET
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       user_agent = COALESCE(EXCLUDED.user_agent, push_subscriptions.user_agent),
       updated_at = now()`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent || null]
  );
  return { ok: true };
}

async function removeSubscription(endpoint) {
  await initPush();
  const ep = typeof endpoint === "string" ? endpoint.trim() : "";
  if (!ep) {
    const err = new Error("endpoint lipsă");
    err.status = 400;
    throw err;
  }
  await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [ep]);
  return { ok: true };
}

async function listSubscriptions() {
  await initPush();
  const { rows } = await query(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY updated_at DESC`
  );
  return rows.map((r) => ({
    endpoint: r.endpoint,
    keys: { p256dh: r.p256dh, auth: r.auth },
  }));
}

function orderPayload(order) {
  const id = order?.order_id ?? order?.id ?? "?";
  const name = String(order?.customer_name || "").trim() || "Client";
  const total = order?.products_total;
  const currency = order?.currency || "RON";
  let amount = currency;
  if (total != null && total !== "") {
    const n = Number(total);
    amount = Number.isFinite(n) ? `${n.toFixed(2)} ${currency}` : `${total} ${currency}`;
  }
  return {
    title: `Comandă eMAG #${id}`,
    body: `${name} · ${amount}`,
    tag: `emag-order-${id}`,
    url: "/vanzari.html",
    order_id: String(id),
  };
}

async function sendToAll(payload) {
  await initPush();
  const subs = await listSubscriptions();
  if (subs.length === 0) {
    return { sent: 0, failed: 0, total: 0 };
  }
  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body, {
          TTL: 60 * 60 * 12,
          urgency: "high",
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        const status = err?.statusCode || err?.status;
        if (status === 404 || status === 410) {
          try {
            await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [
              sub.endpoint,
            ]);
          } catch {
            /* ignore */
          }
        } else {
          console.warn("[push] send failed:", status || err?.message);
        }
      }
    })
  );
  return { sent, failed, total: subs.length };
}

async function notifyNewOrder(order) {
  try {
    const result = await sendToAll(orderPayload(order));
    if (result.total > 0) {
      console.log(
        `[push] comandă ${order?.order_id ?? order?.id}: sent=${result.sent} failed=${result.failed}`
      );
    }
    return result;
  } catch (err) {
    console.warn("[push] notifyNewOrder:", err.message);
    return { sent: 0, failed: 0, total: 0, error: err.message };
  }
}

async function sendTestPush() {
  return sendToAll({
    title: "Comandă eMAG #TEST",
    body: "Test Notificare · 1.00 RON",
    tag: "emag-order-TEST",
    url: "/vanzari.html",
    order_id: "TEST",
  });
}

module.exports = {
  initPush,
  getPublicKey,
  saveSubscription,
  removeSubscription,
  notifyNewOrder,
  sendTestPush,
  listSubscriptions,
};
