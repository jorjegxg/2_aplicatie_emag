const { query, ensureSchema } = require("./pg");
const { normalizeParams } = require("./calculator");

async function getSettings() {
  await ensureSchema();
  const { rows } = await query(
    `SELECT procentaj_emag, procentaj_alte_costuri,
            mult_prp, mult_min, mult_max, calculator_params
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
    calculator_params: normalizeParams(row?.calculator_params),
  };
}

async function saveSettings({
  procentaj_alte_costuri,
  mult_prp,
  mult_min,
  mult_max,
  calculator_params,
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
  if (calculator_params !== undefined) {
    await query("UPDATE settings SET calculator_params = $1 WHERE id = 1", [
      JSON.stringify(normalizeParams(calculator_params)),
    ]);
  }
  return getSettings();
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
         WHERE offer_id = ANY($1::bigint[]) AND channel = $2
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

async function getOrderLinesForProduct(offerId) {
  await ensureSchema();
  const id = Number(offerId);
  if (!Number.isFinite(id)) return [];
  try {
    const { rows } = await query(
      `SELECT l.line_id, l.order_id, COALESCE(l.channel, o.channel, 'emag') AS channel, l.platform,
              l.product_id, l.part_number, l.name, l.quantity, l.sale_price,
              l.status, l.currency, l.order_date,
              o.status AS order_status, o.customer_name, o.payment_mode,
              o.modified_at
       FROM order_line_history l
       LEFT JOIN emag_orders o ON o.order_id = l.order_id
       WHERE l.product_id = $1
       ORDER BY l.order_date DESC NULLS LAST, l.order_id DESC, l.line_id DESC`,
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
  getPretEmagHistory,
  getLastPriceChangeBulk,
  getOrderLinesForProduct,
  getSettings,
  saveSettings,
};
