/**
 * Inregistreaza webhook-ul de comenzi Trendyol (o singura data).
 *   docker compose exec back node scripts/register-trendyol-webhook.js https://<domeniu>/api/webhooks/ty/order
 * Trendyol trimite headerul x-api-key = TRENDYOL_WEBHOOK_TOKEN, verificat de server.js.
 */
const { listWebhooks, registerOrderWebhook } = require("../channels/trendyol");

const STATUSES = [
  "CREATED",
  "PICKING",
  "INVOICED",
  "SHIPPED",
  "CANCELLED",
  "DELIVERED",
  "UNDELIVERED",
  "RETURNED",
  "UNSUPPLIED",
  "AWAITING",
  "UNPACKED",
  "AT_COLLECTION_POINT",
  "VERIFIED",
];

async function main() {
  const url = String(process.argv[2] || "").trim();
  if (!/^https:\/\//.test(url)) {
    throw new Error("Dă URL-ul HTTPS public: .../api/webhooks/ty/order");
  }
  if (/trendyol/i.test(url)) {
    throw new Error("Trendyol refuză URL-uri care conțin cuvântul „trendyol”.");
  }
  const apiKey = String(process.env.TRENDYOL_WEBHOOK_TOKEN || "").trim();
  if (!apiKey) throw new Error("TRENDYOL_WEBHOOK_TOKEN lipsește din .env");

  const existing = await listWebhooks();
  console.log(`[trendyol-webhook] existente: ${existing.length}`);
  for (const w of existing) console.log(`  - ${w.id} ${w.url} (${w.status || "?"})`);
  if (existing.some((w) => w.url === url)) {
    console.log("[trendyol-webhook] URL-ul e deja înregistrat, nimic de făcut.");
    return;
  }

  const res = await registerOrderWebhook({ url, apiKey, subscribedStatuses: STATUSES });
  console.log("[trendyol-webhook] creat:", JSON.stringify(res));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[trendyol-webhook] EROARE:", err.message || err);
    process.exit(1);
  });
