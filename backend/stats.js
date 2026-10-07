/*
 * Statistici (doar citire): vanzari, profit, stoc, retururi, efectul preturilor.
 * Tot calculul se face in JS peste comenzile locale (emag_orders + order_line_history);
 * datele sunt mici, iar asa profitul pe comanda iese 1:1 cu formula din calculator.js.
 */
const { query, ensureSchema } = require("./pg");
const { getSettings } = require("./db");
const { isPlatitorTva } = require("./calculator");

const TZ = "Europe/Bucharest";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PCT_EMAG = 25;
/** Fereastra pentru ritmul de vanzare (stoc ramas in zile). */
const VELOCITY_WINDOW_DAYS = 60;
/** Zilele comparate inainte / dupa o schimbare de pret. */
const PRICE_WINDOW_DAYS = 14;
/** Schimbari mai mici de atat (ex. 149,99 → 149,95) nu conteaza ca schimbare de pret. */
const PRICE_CHANGE_MIN_PCT = 3;

/* ---------------- curs valutar (BNR, cache 6h) ---------------- */

const FALLBACK_RATES = { RON: 1, EUR: 5.0, HUF: 0.0128, BGN: 2.56, USD: 4.4 };
const RATES_TTL_MS = 6 * 60 * 60 * 1000;
let ratesCache = null;

async function getRates() {
  if (ratesCache && Date.now() - ratesCache.fetchedAt < RATES_TTL_MS) return ratesCache;
  try {
    const res = await fetch("https://curs.bnr.ro/nbrfxrates.xml", {
      signal: AbortSignal.timeout(8000),
    });
    const xml = await res.text();
    const rates = { RON: 1 };
    const re = /<Rate currency="([A-Z]{3})"(?: multiplier="(\d+)")?>([\d.]+)<\/Rate>/g;
    let m;
    while ((m = re.exec(xml))) rates[m[1]] = Number(m[3]) / Number(m[2] || 1);
    if (!rates.EUR || !rates.HUF) throw new Error("curs EUR/HUF lipsa in raspuns");
    const date = (xml.match(/<Cube date="([\d-]+)"/) || [])[1] || null;
    ratesCache = { rates, date, source: "BNR", fetchedAt: Date.now() };
  } catch (err) {
    console.warn("[stats] curs BNR indisponibil:", err.message);
    // Pastreaza ultimul curs bun; altfel valori aproximative.
    if (!ratesCache) {
      ratesCache = { rates: FALLBACK_RATES, date: null, source: "aproximativ", fetchedAt: Date.now() };
    }
  }
  return ratesCache;
}

function toRon(amount, currency, rates) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  const rate = rates[String(currency || "RON").toUpperCase()] ?? FALLBACK_RATES[currency] ?? 1;
  return n * rate;
}

/* ---------------- utilitare de data (zile in ora Romaniei) ---------------- */

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

function localDay(date) {
  return dayFmt.format(date);
}

function isDay(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);
}

function round2(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}

/* ---------------- profit pe comanda (formula calculatorului) ---------------- */

/**
 * Profitul net estimat al unei comenzi, ca in calculator.js (rezultatRuta), dar cu
 * cifrele reale ale comenzii: produsele, transportul platit de client si comisionul
 * fiecarei oferte. Costurile fixe pe colet (curier contract + consumabile) se scad o data.
 * Liniile vin deja in RON.
 */
function orderNetProfit(lines, shippingRon, p) {
  const tva = p.tva / 100;
  const imp = (p.regim.startsWith("micro") ? p.impozit_micro : p.impozit_profit) / 100;
  const platitor = isPlatitorTva(p.regim);
  const cct = p.curierat_contract;
  const cons = p.consumabile;
  const cc = shippingRon;

  // U = venit produse (fara TVA la platitor; la neplatitor e chiar pretul platit).
  let U = 0;
  let V = 0;
  let cost = 0;
  for (const l of lines) {
    const u = platitor ? l.netRon : l.grossRon;
    U += u;
    V += u * l.pct;
    cost += l.costRon;
  }
  const avgPct = U > 0 ? V / U : lines[0]?.pct ?? 0;
  // eMAG ia comision si din transportul incasat de la client.
  V += (platitor ? cc / (1 + tva) : cc) * avgPct;
  const W = V * tva;
  const tvaImport = cost - cost / (1 + tva);

  let impozit;
  let profit;
  if (platitor) {
    const venit = U + cc / (1 + tva);
    const chelt = V + (cost - tvaImport) + (cct + cons) / (1 + tva);
    impozit = p.regim.startsWith("micro") ? venit * imp : (venit - chelt) * imp;
    profit = venit - chelt - impozit;
  } else {
    const brut = U + cc - (V + W + cost + cct + cons);
    impozit = p.regim.startsWith("micro") ? (U + cc) * imp : brut * imp;
    profit = brut - impozit;
  }
  return {
    profit,
    commission: V + W,
    fixedCosts: cct + cons,
    tax: impozit,
  };
}

/**
 * Pretul minim (cu TVA, cat plateste clientul) la care o comanda cu o bucata nu pierde bani,
 * cand clientul nu plateste transportul. Aceleasi formule ca break-even din calculator.js, cu cc = 0.
 */
function breakEvenPrice(cost, pct, p) {
  if (cost == null) return null;
  const T = pct;
  const tva = p.tva / 100;
  const imp = (p.regim.startsWith("micro") ? p.impozit_micro : p.impozit_profit) / 100;
  const fixed = cost + p.consumabile + p.curierat_contract;
  let den;
  if (p.regim === "profit_neplatitor") den = 1 - T * (1 + tva);
  else if (p.regim === "profit_platitor") den = 1 - T;
  else if (p.regim === "micro_neplatitor") den = 1 - T * (1 + tva) - imp;
  else den = 1 - T - imp;
  if (den <= 0) return null;
  const be = fixed / den;
  return isPlatitorTva(p.regim) ? be * (1 + tva) : be;
}

/** Profitul "simplu" din pagina Comenzi: pret dupa comision minus pretul de cumparare. */
function lineGrossProfit(l) {
  return l.grossRon * (1 - l.pct) - l.costRon;
}

/* ---------------- incarcare date ---------------- */

async function loadOrders(rates, defaultPct) {
  const { rows: orders } = await query(
    `SELECT order_id, platform, status, order_date, payment_mode_id, payment_mode, currency,
            shipping_tax, vouchers_total,
            to_char(order_date AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day,
            EXTRACT(HOUR FROM order_date AT TIME ZONE '${TZ}')::int AS hour,
            EXTRACT(ISODOW FROM order_date AT TIME ZONE '${TZ}')::int AS dow
     FROM emag_orders
     WHERE order_date IS NOT NULL
     ORDER BY order_date`
  );
  const { rows: lines } = await query(
    `SELECT o.order_id, o.line_id, o.product_id AS offer_id, o.catalog_product_id, o.name,
            o.quantity, o.sale_price, o.vat, o.status, o.currency,
            c.pret_cumparare, c.nume, c.cod_produs, l.procentaj_emag
     FROM order_line_history o
     LEFT JOIN catalog_products c ON c.id = o.catalog_product_id
     LEFT JOIN marketplace_listings l
       ON l.channel = 'emag' AND l.external_id = o.product_id::text`
  );

  const byOrder = new Map();
  for (const r of lines) {
    const qty = Number(r.quantity) > 0 ? Number(r.quantity) : 1;
    const net = toRon(r.sale_price, r.currency, rates) * qty;
    const vat = Number(r.vat) || 0;
    const line = {
      productId: r.catalog_product_id,
      name: r.nume || r.name || "—",
      code: r.cod_produs || null,
      qty,
      cancelled: Number(r.status) === 0,
      netRon: net,
      grossRon: net * (1 + vat),
      costRon: r.pret_cumparare == null ? null : Number(r.pret_cumparare) * qty,
      pct: (r.procentaj_emag != null ? Number(r.procentaj_emag) : defaultPct) / 100,
      pctDefault: r.procentaj_emag == null,
    };
    const key = String(r.order_id);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(line);
  }

  return orders.map((o) => ({
    id: String(o.order_id),
    platform: o.platform || "ro",
    status: Number(o.status),
    day: o.day,
    hour: o.hour,
    dow: o.dow,
    date: o.order_date,
    payment: o.payment_mode || (o.payment_mode_id != null ? String(o.payment_mode_id) : "—"),
    currency: o.currency || "RON",
    shippingRon: toRon(o.shipping_tax, o.currency, rates),
    lines: byOrder.get(String(o.order_id)) || [],
  }));
}

/* ---------------- agregare ---------------- */

/** Anulat (0) si returnat (5) nu intra in vanzari; restul (nou → finalizat) da. */
function isSale(order) {
  return order.status !== 0 && order.status !== 5;
}

function evaluateOrder(order, params) {
  const lines = order.lines.filter((l) => !l.cancelled);
  const complete = lines.length > 0 && lines.every((l) => l.costRon != null);
  const revenue = lines.reduce((s, l) => s + l.grossRon, 0);
  const units = lines.reduce((s, l) => s + l.qty, 0);
  if (!complete) return { lines, revenue, units, complete, net: null, gross: null };
  const gross = lines.reduce((s, l) => s + lineGrossProfit(l), 0);
  const net = orderNetProfit(lines, order.shippingRon, params);
  return { lines, revenue, units, complete, gross, net };
}

function summarize(orders, evals, params) {
  let sales = 0;
  let returned = 0;
  let cancelled = 0;
  let revenue = 0;
  let units = 0;
  let gross = 0;
  let net = 0;
  let commission = 0;
  let fixedCosts = 0;
  let tax = 0;
  let cost = 0;
  let shipping = 0;
  let profitOrders = 0;
  let lossOrders = 0;
  let incomplete = 0;
  orders.forEach((o, i) => {
    if (o.status === 0) cancelled += 1;
    if (o.status === 5) returned += 1;
    if (!isSale(o)) return;
    const e = evals[i];
    sales += 1;
    revenue += e.revenue;
    units += e.units;
    shipping += o.shippingRon;
    if (!e.complete) {
      incomplete += 1;
      return;
    }
    profitOrders += 1;
    gross += e.gross;
    net += e.net.profit;
    commission += e.net.commission;
    fixedCosts += e.net.fixedCosts;
    tax += e.net.tax;
    cost += e.lines.reduce((s, l) => s + l.costRon, 0);
    if (e.net.profit < 0) lossOrders += 1;
  });
  const decided = sales + returned;
  return {
    orders: sales,
    returned,
    cancelled,
    units,
    revenue: round2(revenue),
    shipping: round2(shipping),
    gross: round2(gross),
    net: round2(net),
    commission: round2(commission),
    fixedCosts: round2(fixedCosts),
    tax: round2(tax),
    cost: round2(cost),
    aov: sales ? round2(revenue / sales) : null,
    netPerOrder: profitOrders ? round2(net / profitOrders) : null,
    margin: revenue > 0 && profitOrders ? round2((net / revenue) * 100) : null,
    returnRate: decided ? round2((returned / decided) * 100) : null,
    lossOrders,
    incomplete,
    // Retur: curierul platit la dus + consumabilele s-au pierdut (estimare).
    returnCost: round2(returned * (params.curierat_contract + params.consumabile)),
  };
}

function inRange(o, from, to) {
  return o.day >= from && o.day <= to;
}

/** Schimbarile de pret (pe zi, ultimul pret al zilei) cu vanzarile din jurul lor. */
async function priceEffects(orders, evals, today, dataStart) {
  const { rows } = await query(
    `SELECT h.offer_id, h.sale_price, h.currency,
            to_char(h.recorded_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day,
            l.product_id, c.nume, c.cod_produs
     FROM product_pret_emag_history h
     LEFT JOIN marketplace_listings l ON l.channel = h.channel AND l.external_id = h.offer_id::text
     LEFT JOIN catalog_products c ON c.id = l.product_id
     WHERE h.channel = 'emag'
     ORDER BY h.offer_id, h.recorded_at`
  );
  // Ultimul pret al fiecarei zile, pe oferta.
  const daily = new Map();
  for (const r of rows) {
    const key = String(r.offer_id);
    if (!daily.has(key)) daily.set(key, { meta: r, days: new Map() });
    daily.get(key).days.set(r.day, Number(r.sale_price));
  }

  // Unitati vandute pe produs, pe zi (vanzari valide, RO/HU/BG laolalta).
  const unitsByProductDay = new Map();
  orders.forEach((o, i) => {
    if (!isSale(o)) return;
    for (const l of evals[i].lines) {
      if (l.productId == null) continue;
      const k = `${l.productId}|${o.day}`;
      unitsByProductDay.set(k, (unitsByProductDay.get(k) || 0) + l.qty);
    }
  });
  const unitsBetween = (productId, from, to) => {
    let s = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) s += unitsByProductDay.get(`${productId}|${d}`) || 0;
    return s;
  };

  const events = [];
  for (const { meta, days } of daily.values()) {
    if (meta.product_id == null) continue;
    let prev = null;
    for (const [day, price] of [...days.entries()].sort()) {
      if (prev && Math.abs(price - prev.price) / prev.price >= PRICE_CHANGE_MIN_PCT / 100) {
        events.push({ productId: meta.product_id, name: meta.nume || "—", code: meta.cod_produs, day, from: prev.price, to: price });
      }
      prev = { day, price };
    }
  }

  // Ferestrele se taie la urmatoarea schimbare a aceluiasi produs, ca sa nu amestece preturi.
  events.sort((a, b) => (a.productId - b.productId) || a.day.localeCompare(b.day));
  const out = events.map((e, i) => {
    const prevEv = events[i - 1]?.productId === e.productId ? events[i - 1] : null;
    const nextEv = events[i + 1]?.productId === e.productId ? events[i + 1] : null;
    let beforeFrom = addDays(e.day, -PRICE_WINDOW_DAYS);
    if (beforeFrom < dataStart) beforeFrom = dataStart;
    if (prevEv && beforeFrom < prevEv.day) beforeFrom = prevEv.day;
    const beforeTo = addDays(e.day, -1);
    let afterTo = addDays(e.day, PRICE_WINDOW_DAYS - 1);
    if (afterTo > today) afterTo = today;
    const cutByNext = Boolean(nextEv && afterTo >= nextEv.day);
    if (cutByNext) afterTo = addDays(nextEv.day, -1);
    const beforeDays = Math.max(0, daysBetween(beforeFrom, beforeTo) + 1);
    const afterDays = Math.max(0, daysBetween(e.day, afterTo) + 1);
    const before = beforeDays ? unitsBetween(e.productId, beforeFrom, beforeTo) : 0;
    const after = afterDays ? unitsBetween(e.productId, e.day, afterTo) : 0;
    return {
      ...e,
      changePct: round2(((e.to - e.from) / e.from) * 100),
      cutByNext,
      beforeDays,
      afterDays,
      beforeUnits: before,
      afterUnits: after,
      beforePerWeek: beforeDays ? round2((before / beforeDays) * 7) : null,
      afterPerWeek: afterDays ? round2((after / afterDays) * 7) : null,
    };
  });
  return out.sort((a, b) => b.day.localeCompare(a.day)).slice(0, 40);
}

async function stockTable(orders, evals, today, dataStart, rates, params, defaultPct) {
  const { rows } = await query(
    `SELECT c.id, c.cod_produs, c.nume, c.general_stock, c.pret_cumparare, c.sale_price, c.currency,
            l.procentaj_emag
     FROM catalog_products c
     LEFT JOIN marketplace_listings l ON l.channel = 'emag' AND l.external_id = c.emag_offer_id
     ORDER BY c.nume`
  );
  const windowDays = Math.max(1, Math.min(VELOCITY_WINDOW_DAYS, daysBetween(dataStart, today) + 1));
  const windowFrom = addDays(today, -(windowDays - 1));
  const from30 = addDays(today, -29);

  const agg = new Map();
  orders.forEach((o, i) => {
    if (!isSale(o)) return;
    for (const l of evals[i].lines) {
      if (l.productId == null) continue;
      const a = agg.get(l.productId) || { all: 0, win: 0, d30: 0, last: null };
      a.all += l.qty;
      if (o.day >= windowFrom) a.win += l.qty;
      if (o.day >= from30) a.d30 += l.qty;
      if (!a.last || o.day > a.last) a.last = o.day;
      agg.set(l.productId, a);
    }
  });

  return {
    windowDays,
    items: rows.map((r) => {
      const stock = Number(r.general_stock) || 0;
      const cost = r.pret_cumparare == null ? null : Number(r.pret_cumparare);
      const a = agg.get(r.id) || { all: 0, win: 0, d30: 0, last: null };
      const perDay = a.win / windowDays;
      const daysLeft = perDay > 0 ? stock / perDay : null;
      const sinceLast = a.last ? daysBetween(a.last, today) : null;
      let state;
      if (stock <= 0) state = a.all > 0 ? "epuizat" : "fara-stoc";
      else if (a.all === 0) state = "nevandut";
      else if (sinceLast > 30) state = "blocat";
      else if (daysLeft != null && daysLeft < 14) state = "critic";
      else if (daysLeft != null && daysLeft > 180) state = "lent";
      else state = "ok";
      const price = r.sale_price == null ? null : toRon(r.sale_price, r.currency, rates);
      const pct = (r.procentaj_emag != null ? Number(r.procentaj_emag) : defaultPct) / 100;
      const breakEven = breakEvenPrice(cost, pct, params);
      return {
        id: r.id,
        code: r.cod_produs,
        name: r.nume || "—",
        stock,
        cost,
        value: cost == null ? null : round2(stock * cost),
        price: round2(price),
        pct: round2(pct * 100),
        breakEven: round2(breakEven),
        belowBreakEven: price != null && breakEven != null && price < breakEven,
        soldAll: a.all,
        sold30: a.d30,
        perWeek: round2(perDay * 7),
        daysLeft: daysLeft == null ? null : Math.round(daysLeft),
        lastSale: a.last,
        sinceLast,
        state,
      };
    }),
  };
}

async function getStats({ from, to, platform } = {}) {
  await ensureSchema();
  const [settings, fx] = await Promise.all([getSettings(), getRates()]);
  const params = settings.calculator_params;
  const defaultPct = settings.procentaj_emag ?? DEFAULT_PCT_EMAG;
  const today = localDay(new Date());

  const allOrders = await loadOrders(fx.rates, defaultPct);
  const dataStart = allOrders[0]?.day || today;
  const plat = ["ro", "hu", "bg"].includes(platform) ? platform : null;

  const toDay = isDay(to) ? to : today;
  const fromDay = isDay(from) ? from : addDays(toDay, -29);
  const spanDays = daysBetween(fromDay, toDay) + 1;
  const prevTo = addDays(fromDay, -1);
  const prevFrom = addDays(prevTo, -(spanDays - 1));

  const allEvals = allOrders.map((o) => evaluateOrder(o, params));
  const pick = (f, t, byPlatform = true) => {
    const idx = [];
    allOrders.forEach((o, i) => {
      if (inRange(o, f, t) && (!byPlatform || !plat || o.platform === plat)) idx.push(i);
    });
    return { orders: idx.map((i) => allOrders[i]), evals: idx.map((i) => allEvals[i]) };
  };

  const cur = pick(fromDay, toDay);
  const prev = pick(prevFrom, prevTo);

  // Serie zilnica (zilele fara comenzi apar cu 0, ca graficul sa nu sara peste ele).
  const series = [];
  const dayIdx = new Map();
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) {
    dayIdx.set(d, series.length);
    series.push({ day: d, orders: 0, revenue: 0, net: 0, returned: 0 });
  }
  cur.orders.forEach((o, i) => {
    const s = series[dayIdx.get(o.day)];
    if (!s) return;
    if (o.status === 5) s.returned += 1;
    if (!isSale(o)) return;
    const e = cur.evals[i];
    s.orders += 1;
    s.revenue += e.revenue;
    if (e.net) s.net += e.net.profit;
  });
  series.forEach((s) => {
    s.revenue = round2(s.revenue);
    s.net = round2(s.net);
  });

  // Pe platforma: mereu toate trei, indiferent de filtru.
  const platforms = ["ro", "hu", "bg"].map((p) => {
    const sub = pick(fromDay, toDay, false);
    const idx = sub.orders.map((o, i) => (o.platform === p ? i : -1)).filter((i) => i >= 0);
    return { platform: p, ...summarize(idx.map((i) => sub.orders[i]), idx.map((i) => sub.evals[i]), params) };
  });

  const weekday = Array(7).fill(0);
  const hours = Array(24).fill(0);
  const payments = new Map();
  cur.orders.forEach((o) => {
    if (!isSale(o)) return;
    weekday[o.dow - 1] += 1;
    hours[o.hour] += 1;
    payments.set(o.payment, (payments.get(o.payment) || 0) + 1);
  });

  // Pe produs, in perioada aleasa. Profitul net al comenzii se imparte pe linii dupa valoare.
  const products = new Map();
  cur.orders.forEach((o, i) => {
    const e = cur.evals[i];
    for (const l of e.lines) {
      const key = l.productId ?? `n:${l.name}`;
      const p = products.get(key) || {
        id: l.productId, name: l.name, code: l.code, units: 0, orders: 0, revenue: 0,
        gross: 0, net: 0, netKnown: true, returnedUnits: 0, pct: round2(l.pct * 100), pctDefault: l.pctDefault,
      };
      if (o.status === 5) {
        p.returnedUnits += l.qty;
      } else if (isSale(o)) {
        p.units += l.qty;
        p.orders += 1;
        p.revenue += l.grossRon;
        if (e.complete) {
          p.gross += lineGrossProfit(l);
          p.net += e.revenue > 0 ? e.net.profit * (l.grossRon / e.revenue) : 0;
        } else {
          p.netKnown = false;
        }
      }
      products.set(key, p);
    }
  });
  const productList = [...products.values()]
    .map((p) => ({
      ...p,
      revenue: round2(p.revenue),
      gross: round2(p.gross),
      net: p.netKnown ? round2(p.net) : null,
      netPerUnit: p.netKnown && p.units ? round2(p.net / p.units) : null,
      margin: p.netKnown && p.revenue > 0 ? round2((p.net / p.revenue) * 100) : null,
      returnRate: p.units + p.returnedUnits ? round2((p.returnedUnits / (p.units + p.returnedUnits)) * 100) : null,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // Comenzile in pierdere: unde se duc banii.
  const lossOrders = cur.orders
    .map((o, i) => ({ o, e: cur.evals[i] }))
    .filter(({ o, e }) => isSale(o) && e.net && e.net.profit < 0)
    .map(({ o, e }) => ({
      id: o.id,
      day: o.day,
      platform: o.platform,
      revenue: round2(e.revenue),
      shipping: round2(o.shippingRon),
      cost: round2(e.lines.reduce((s, l) => s + l.costRon, 0)),
      commission: round2(e.net.commission),
      fixedCosts: round2(e.net.fixedCosts),
      net: round2(e.net.profit),
      products: e.lines.map((l) => l.name),
    }))
    .sort((a, b) => a.net - b.net);

  const lastSale = [...allOrders].reverse().find(isSale);
  const stock = await stockTable(allOrders, allEvals, today, dataStart, fx.rates, params, defaultPct);
  const prices = await priceEffects(allOrders, allEvals, today, dataStart);

  return {
    meta: {
      from: fromDay,
      to: toDay,
      prevFrom,
      prevTo,
      platform: plat,
      today,
      dataStart,
      lastOrderDay: lastSale?.day || null,
      daysSinceLastOrder: lastSale ? daysBetween(lastSale.day, today) : null,
      rates: { EUR: round2(fx.rates.EUR * 10000) / 10000, HUF: fx.rates.HUF, date: fx.date, source: fx.source },
      params: {
        regim: params.regim,
        curierat_contract: params.curierat_contract,
        consumabile: params.consumabile,
        impozit: params.regim.startsWith("micro") ? params.impozit_micro : params.impozit_profit,
        tva: params.tva,
        defaultPct,
      },
      defaultPctLines: cur.evals.reduce((s, e) => s + e.lines.filter((l) => l.pctDefault).length, 0),
    },
    kpis: summarize(cur.orders, cur.evals, params),
    previous: summarize(prev.orders, prev.evals, params),
    series,
    platforms,
    weekday,
    hours,
    payments: [...payments.entries()].map(([mode, count]) => ({ mode, count })).sort((a, b) => b.count - a.count),
    products: productList,
    lossOrders: lossOrders.slice(0, 20),
    stock,
    prices,
  };
}

module.exports = { getStats, orderNetProfit, breakEvenPrice };
