const { query, withTransaction, ensureSchema } = require("./pg");

async function lookupPretCumparare(partNumber, name) {
  await ensureSchema();
  const cod = String(partNumber ?? "").trim();
  if (cod) {
    const { rows } = await query(
      `SELECT pret_cumparare FROM catalog_products
       WHERE LOWER(cod_produs) = LOWER($1) LIMIT 1`,
      [cod]
    );
    if (rows[0] && rows[0].pret_cumparare != null) {
      return Number(rows[0].pret_cumparare);
    }
  }

  const nume = String(name ?? "").trim();
  if (nume) {
    const { rows } = await query(
      `SELECT pret_cumparare FROM catalog_products
       WHERE LOWER(nume) = LOWER($1) LIMIT 1`,
      [nume]
    );
    if (rows[0] && rows[0].pret_cumparare != null) {
      return Number(rows[0].pret_cumparare);
    }
  }

  return null;
}

async function getSettings() {
  await ensureSchema();
  const { rows } = await query(
    `SELECT procentaj_emag, procentaj_alte_costuri,
            mult_prp, mult_min, mult_max
     FROM settings WHERE id = 1`
  );
  const row = rows[0];
  return {
    procentaj_emag: row?.procentaj_emag != null ? Number(row.procentaj_emag) : null,
    procentaj_alte_costuri:
      row?.procentaj_alte_costuri != null ? Number(row.procentaj_alte_costuri) : null,
    mult_prp: row?.mult_prp != null ? Number(row.mult_prp) : null,
    mult_min: row?.mult_min != null ? Number(row.mult_min) : null,
    mult_max: row?.mult_max != null ? Number(row.mult_max) : null,
  };
}

async function saveSettings({
  procentaj_alte_costuri,
  mult_prp,
  mult_min,
  mult_max,
}) {
  await ensureSchema();
  await query(
    `UPDATE settings
     SET procentaj_alte_costuri = $1,
         mult_prp = $2,
         mult_min = $3,
         mult_max = $4
     WHERE id = 1`,
    [procentaj_alte_costuri, mult_prp, mult_min, mult_max]
  );
  return getSettings();
}

const PRICE_EPSILON = 0.00005;

async function recordPretEmagIfChanged(offerId, salePrice, currency, source, channel = "emag") {
  await ensureSchema();
  const id = Number(offerId);
  const price = Number(salePrice);
  if (!Number.isFinite(id) || !Number.isFinite(price)) return null;

  const ch = String(channel || "emag").trim().toLowerCase() || "emag";

  const { rows: lastRows } = await query(
    `SELECT sale_price FROM product_pret_emag_history
     WHERE offer_id = $1 AND channel = $2
     ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [id, ch]
  );
  const last = lastRows[0];

  if (last != null && Math.abs(Number(last.sale_price) - price) <= PRICE_EPSILON) {
    return null;
  }

  const recorded_at = new Date().toISOString();
  await query(
    `INSERT INTO product_pret_emag_history
       (offer_id, sale_price, currency, recorded_at, source, channel)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, price, currency || null, recorded_at, source || null, ch]
  );
  return { offer_id: id, sale_price: price, recorded_at, source: source || null, channel: ch };
}

async function getPretEmagHistory(offerId, channel = "emag") {
  await ensureSchema();
  const id = Number(offerId);
  if (!Number.isFinite(id)) return [];
  const ch = String(channel || "emag").trim().toLowerCase() || "emag";
  try {
    const { rows } = await query(
      `SELECT sale_price, currency, recorded_at, source, channel
       FROM product_pret_emag_history
       WHERE offer_id = $1 AND channel = $2
       ORDER BY recorded_at ASC, id ASC`,
      [id, ch]
    );
    return rows.map((r) => ({
      ...r,
      sale_price: Number(r.sale_price),
      recorded_at:
        r.recorded_at instanceof Date ? r.recorded_at.toISOString() : r.recorded_at,
    }));
  } catch {
    return [];
  }
}

async function getLastPriceChangeBulk(offerIds, channel = "emag") {
  await ensureSchema();
  const ids = [
    ...new Set(
      (Array.isArray(offerIds) ? offerIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id))
    ),
  ];
  if (ids.length === 0) return {};
  const ch = String(channel || "emag").trim().toLowerCase() || "emag";

  try {
    const { rows } = await query(
      `SELECT h.offer_id, h.sale_price, h.recorded_at
       FROM product_pret_emag_history h
       JOIN (
         SELECT offer_id, MAX(id) AS max_id
         FROM product_pret_emag_history
         WHERE offer_id = ANY($1::int[]) AND channel = $2
         GROUP BY offer_id
       ) last ON last.offer_id = h.offer_id AND last.max_id = h.id`,
      [ids, ch]
    );

    const out = {};
    for (const row of rows) {
      out[row.offer_id] = {
        sale_price: Number(row.sale_price),
        recorded_at:
          row.recorded_at instanceof Date
            ? row.recorded_at.toISOString()
            : row.recorded_at,
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function upsertOrderLines(lines) {
  await ensureSchema();
  const list = Array.isArray(lines) ? lines : [];

  const toNum = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  try {
    return await withTransaction(async (client) => {
      let count = 0;
      for (const r of list) {
        const line_id = toNum(r?.line_id);
        const order_id = toNum(r?.order_id);
        if (line_id == null || order_id == null) continue;
        await client.query(
          `INSERT INTO order_line_history
             (line_id, order_id, product_id, part_number, name, quantity, sale_price, status, currency, order_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (line_id) DO UPDATE SET
             order_id = EXCLUDED.order_id,
             product_id = EXCLUDED.product_id,
             part_number = EXCLUDED.part_number,
             name = EXCLUDED.name,
             quantity = EXCLUDED.quantity,
             sale_price = EXCLUDED.sale_price,
             status = EXCLUDED.status,
             currency = EXCLUDED.currency,
             order_date = EXCLUDED.order_date`,
          [
            line_id,
            order_id,
            toNum(r?.product_id),
            r?.part_number ?? null,
            r?.name ?? null,
            toNum(r?.quantity),
            toNum(r?.sale_price),
            toNum(r?.status),
            r?.currency ?? null,
            r?.order_date ?? null,
          ]
        );
        count += 1;
      }
      return count;
    });
  } catch {
    return 0;
  }
}

async function getOrderLinesForProduct(offerId) {
  await ensureSchema();
  const id = Number(offerId);
  if (!Number.isFinite(id)) return [];
  try {
    const { rows } = await query(
      `SELECT line_id, order_id, product_id, part_number, name, quantity,
              sale_price, status, currency, order_date
       FROM order_line_history
       WHERE product_id = $1
       ORDER BY order_date DESC, order_id DESC`,
      [id]
    );
    return rows.map((r) => ({
      ...r,
      quantity: r.quantity != null ? Number(r.quantity) : null,
      sale_price: r.sale_price != null ? Number(r.sale_price) : null,
      order_date:
        r.order_date instanceof Date ? r.order_date.toISOString() : r.order_date,
    }));
  } catch {
    return [];
  }
}

module.exports = {
  lookupPretCumparare,
  recordPretEmagIfChanged,
  getPretEmagHistory,
  getLastPriceChangeBulk,
  upsertOrderLines,
  getOrderLinesForProduct,
  getSettings,
  saveSettings,
};
