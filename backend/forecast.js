/**
 * Prognoza: în cât timp se vinde stocul fiecărui produs, după ritmul de până acum.
 *
 * Vânzări = bucăți din comenzile eMAG (RO/HU/BG) și Trendyol, fără anulate, returnate,
 * comenzi de test și comanda falsă 534856443 (rudă, anulată).
 * Ritmul pe zi e media a două ritmuri:
 *   - ritmul pe tot istoricul (de la prima comandă din magazin până azi),
 *   - ritmul din ultimele 30 de zile (prinde dacă produsul a pornit sau s-a oprit).
 * Zile până la epuizare = stoc / ritm. Fără vânzări: nu se poate estima.
 */
const { query, ensureSchema } = require("./pg");

const RECENT_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;
const EXCLUDED_ORDERS = ["534856443"];
// Trendyol: stările care nu sunt vânzare.
const TY_NOT_SOLD = ["Cancelled", "Returned", "UnSupplied", "UnDelivered"];

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function confidence(units) {
  if (units >= 6) return "bună";
  if (units >= 3) return "medie";
  if (units >= 1) return "slabă";
  return "—";
}

async function getForecast() {
  await ensureSchema();
  const { rows: sales } = await query(
    `SELECT catalog_product_id AS pid, channel, qty, order_date FROM (
       SELECT l.catalog_product_id, 'emag_' || o.platform AS channel,
              GREATEST(COALESCE(l.quantity, 1), 0) AS qty, o.order_date
       FROM order_line_history l
       JOIN emag_orders o ON o.order_id = l.order_id
       WHERE COALESCE(l.status, 1) = 1
         AND COALESCE(o.status, 1) NOT IN (0, 5)
         AND COALESCE(o.received_via, '') <> 'test'
         AND o.order_id::text <> ALL($1::text[])
       UNION ALL
       SELECT catalog_product_id, 'trendyol', GREATEST(COALESCE(quantity, 1), 0), order_date
       FROM trendyol_order_lines
       WHERE COALESCE(status, '') <> ALL($2::text[])
     ) s
     WHERE order_date IS NOT NULL`,
    [EXCLUDED_ORDERS, TY_NOT_SOLD]
  );
  const { rows: products } = await query(
    `SELECT id, cod_produs, nume, general_stock, pret_cumparare, decizie
     FROM catalog_products ORDER BY cod_produs`
  );
  const { rows: counts } = await query(
    `SELECT
       (SELECT count(*) FROM emag_orders) AS emag_orders,
       (SELECT count(DISTINCT order_number) FROM trendyol_order_lines) AS trendyol_orders,
       (SELECT count(*) FROM order_line_history WHERE catalog_product_id IS NULL) AS emag_unlinked,
       (SELECT count(*) FROM trendyol_order_lines WHERE catalog_product_id IS NULL) AS trendyol_unlinked`
  );

  const now = Date.now();
  const firstSale = sales.reduce((m, s) => Math.min(m, new Date(s.order_date).getTime()), now);
  const historyDays = Math.max(1, (now - firstSale) / DAY_MS);
  const recentDays = Math.min(RECENT_DAYS, historyDays);
  const recentFrom = now - recentDays * DAY_MS;

  const byProduct = new Map();
  for (const s of sales) {
    if (s.pid == null) continue;
    const t = new Date(s.order_date).getTime();
    const qty = Number(s.qty) || 0;
    const p = byProduct.get(s.pid) || { units: 0, recent: 0, last: 0, first: now, channels: {} };
    p.units += qty;
    if (t >= recentFrom) p.recent += qty;
    p.last = Math.max(p.last, t);
    p.first = Math.min(p.first, t);
    p.channels[s.channel] = (p.channels[s.channel] || 0) + qty;
    byProduct.set(s.pid, p);
  }

  const items = products.map((c) => {
    const s = byProduct.get(c.id) || { units: 0, recent: 0, last: 0, first: null, channels: {} };
    const stock = Number(c.general_stock) || 0;
    const rateAll = s.units / historyDays;
    const rateRecent = s.recent / recentDays;
    const rate = (rateAll + rateRecent) / 2;
    const days = rate > 0 && stock > 0 ? stock / rate : null;
    let state;
    if (stock <= 0) state = s.units > 0 ? "epuizat" : "fara_stoc";
    else if (!s.units) state = "fara_vanzari";
    else if (days <= 14) state = "curand";
    else if (days <= 60) state = "normal";
    else state = "lent";
    return {
      id: c.id,
      code: c.cod_produs,
      name: c.nume,
      decision: c.decizie || null,
      stock,
      units: s.units,
      recent: s.recent,
      channels: s.channels,
      perMonth: round(rate * 30, 2),
      rate: round(rate, 4),
      days: days == null ? null : round(days, 1),
      soldOutAt: days == null ? null : new Date(now + days * DAY_MS).toISOString(),
      firstSale: s.first ? new Date(s.first).toISOString() : null,
      lastSale: s.last ? new Date(s.last).toISOString() : null,
      stockValue: c.pret_cumparare == null ? null : round(stock * Number(c.pret_cumparare), 2),
      confidence: confidence(s.units),
      state,
    };
  });

  const totalStock = items.reduce((a, i) => a + i.stock, 0);
  const totalRate = items.reduce((a, i) => a + i.rate, 0);
  return {
    generatedAt: new Date(now).toISOString(),
    historyFrom: sales.length ? new Date(firstSale).toISOString() : null,
    historyDays: round(historyDays, 1),
    recentDays: round(recentDays, 1),
    counts: Object.fromEntries(Object.entries(counts[0] || {}).map(([k, v]) => [k, Number(v)])),
    totals: {
      stock: totalStock,
      units: items.reduce((a, i) => a + i.units, 0),
      perMonth: round(totalRate * 30, 1),
      // Tot stocul care se vinde, la ritmul de acum (produsele fără vânzări nu intră).
      daysForSelling: totalRate > 0
        ? round(items.filter((i) => i.rate > 0).reduce((a, i) => a + i.stock, 0) / totalRate, 0)
        : null,
      stockWithoutSales: items.filter((i) => i.state === "fara_vanzari").reduce((a, i) => a + i.stock, 0),
    },
    items,
  };
}

module.exports = { getForecast };
