const {
  ITEMS_PER_PAGE,
  toEmagDatetime,
  resolveEmagAuth,
  emagOrderRead,
} = require("../emag-client");
const { applyEmagOrder } = require("../stock-movements");

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const EMPTY_STREAK_STOP = 6;
const FLOOR_DATE = new Date("2015-01-01T00:00:00");

async function fetchWindowPage(auth, page, createdAfter, createdBefore) {
  const { response, json, text } = await emagOrderRead(auth, {
    page,
    createdAfter,
    createdBefore,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Auth eMAG eșuată mid-sync (HTTP ${response.status})`);
  }
  if (!json) {
    throw new Error(`Răspuns invalid eMAG (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  if (json.isError) {
    throw new Error(`eMAG eroare: ${JSON.stringify(json.messages || [])}`);
  }

  return Array.isArray(json.results) ? json.results : [];
}

async function syncWindow(auth, windowStart, windowEnd) {
  const createdAfter = toEmagDatetime(windowStart);
  const createdBefore = toEmagDatetime(windowEnd);
  let page = 1;
  let windowOrders = 0;
  let windowLines = 0;

  for (;;) {
    const orders = await fetchWindowPage(auth, page, createdAfter, createdBefore);
    let upserted = 0;
    for (const order of orders) {
      await applyEmagOrder(order, { via: "sync", notify: false, adjustStock: false });
      upserted += Array.isArray(order?.products) ? order.products.length : 0;
    }

    windowOrders += orders.length;
    windowLines += upserted;

    console.log(
      `[sync:orders] ${createdAfter} → ${createdBefore} page=${page} ` +
        `orders=${orders.length} lines=${upserted}`
    );

    if (orders.length < ITEMS_PER_PAGE) break;
    page += 1;
  }

  return { windowOrders, windowLines };
}

async function main() {
  const auth = await resolveEmagAuth("sync-orders");

  let windowEnd = new Date();
  let emptyStreak = 0;
  let totalOrders = 0;
  let totalLines = 0;
  let windows = 0;

  console.log("[sync:orders] start walker istoric (ferestre 30 zile)");

  while (windowEnd > FLOOR_DATE && emptyStreak < EMPTY_STREAK_STOP) {
    const windowStart = new Date(Math.max(windowEnd.getTime() - WINDOW_MS, FLOOR_DATE.getTime()));
    const { windowOrders, windowLines } = await syncWindow(auth, windowStart, windowEnd);

    windows += 1;
    totalOrders += windowOrders;
    totalLines += windowLines;

    if (windowOrders === 0) {
      emptyStreak += 1;
    } else {
      emptyStreak = 0;
    }

    windowEnd = windowStart;
  }

  const stopReason =
    emptyStreak >= EMPTY_STREAK_STOP
      ? `${EMPTY_STREAK_STOP} ferestre consecutive goale`
      : `floor ${toEmagDatetime(FLOOR_DATE)}`;

  console.log(
    `[sync:orders] gata — stop: ${stopReason}; ` +
      `windows=${windows} orders=${totalOrders} lines_upserted=${totalLines}`
  );
}

main().catch((err) => {
  console.error("[sync:orders] EROARE:", err.message || err);
  process.exit(1);
});
