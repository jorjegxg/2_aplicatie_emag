/*
 * Calcule si formatari folosite de ambele tabele: produsele (index.html)
 * si preturile/marja per canal (sync.html). Fara dependente de DOM-ul unei pagini.
 */
(function (global) {
  const DEFAULT_ALTE_COSTURI = 0;
  const DEFAULT_PROcentaj_EMAG = 25;
  const PCT_LEVEL_CLASSES = ["pct-1", "pct-2", "pct-3"];

  /* ---------- formatari ---------- */

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatPrice(price, currency) {
    if (price == null || price === "") return "—";
    const num = Number(price);
    if (Number.isNaN(num)) return escapeHtml(price);
    return `${num.toFixed(2)} ${escapeHtml(currency || "RON")}`;
  }

  function formatPercent(value) {
    if (value == null || value === "") return "—";
    const num = Number(value);
    if (Number.isNaN(num)) return "—";
    return `${num.toFixed(2)}%`;
  }

  function daysSince(iso) {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return (Date.now() - t) / (24 * 60 * 60 * 1000);
  }

  function relativeTimeRo(iso) {
    const d = daysSince(iso);
    if (d == null) return "—";
    const days = Math.floor(d);
    if (days <= 0) {
      const hours = Math.floor(d * 24);
      if (hours <= 0) return "acum";
      return `acum ${hours} h`;
    }
    if (days === 1) return "acum 1 zi";
    if (days < 30) return `acum ${days} zile`;
    const months = Math.floor(days / 30);
    if (months === 1) return "acum ~1 lună";
    if (months < 12) return `acum ~${months} luni`;
    const years = Math.floor(days / 365);
    return years === 1 ? "acum ~1 an" : `acum ~${years} ani`;
  }

  function stalenessClass(iso) {
    const d = daysSince(iso);
    if (d == null) return "";
    if (d < 30) return "is-stale-fresh";
    if (d < 90) return "is-stale-warn";
    return "is-stale-old";
  }

  function procentajLevelClass(value) {
    if (value == null || value === "") return "";
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    // Match displayed toFixed(2) so 19.996 → "20.00" gets the same color
    const shown = Math.round(n * 100) / 100;
    if (shown < 20) return "pct-1";
    return "pct-2";
  }

  function formatStatus(status) {
    if (status === 1 || status === "1") {
      return '<span class="badge badge-active">Activ</span>';
    }
    if (status === 0 || status === "0") {
      return '<span class="badge badge-inactive">Inactiv</span>';
    }
    return escapeHtml(status ?? "—");
  }

  /* ---------- parsari ---------- */

  const numOrNull = (v) =>
    v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v);

  function parseJsonAttr(raw, fallback) {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function parseSortNumber(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s || s === "—") return null;
    const cleaned = s.replace(/[^\d.,\-]/g, "").replace(",", ".");
    if (!cleaned || cleaned === "-" || cleaned === ".") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function parseAlteCosturi(raw) {
    if (raw == null || raw === "") return DEFAULT_ALTE_COSTURI;
    const n = Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_ALTE_COSTURI;
  }

  function roundPrice(n) {
    return Math.round(n * 10000) / 10000;
  }

  function pricesEqual(a, b) {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) {
      return String(a ?? "") === String(b ?? "");
    }
    return Math.abs(na - nb) < 0.00005;
  }

  function stockSumFromArr(stock) {
    if (!Array.isArray(stock) || !stock.length) return 0;
    return stock.reduce((sum, x) => sum + (Number(x.value) || 0), 0);
  }

  /* ---------- costuri derivate din procentaj ---------- */

  function alteFromProcentaj(procentaj, pretCumparare) {
    const buy = Number(pretCumparare);
    const pct = Number(procentaj);
    if (!Number.isFinite(buy) || buy <= 0 || !Number.isFinite(pct)) {
      return DEFAULT_ALTE_COSTURI;
    }
    return Math.round(buy * (pct / 100) * 100) / 100;
  }

  /* ---------- profit ---------- */

  function calcProfit(
    salePrice,
    pretCumparare,
    alteCosturi = DEFAULT_ALTE_COSTURI,
    pctEmag
  ) {
    if (pctEmag == null || pctEmag === "") return null;
    const pct = Number(pctEmag);
    if (salePrice == null || salePrice === "" || Number.isNaN(pct)) {
      return null;
    }
    const sale = Number(salePrice);
    if (Number.isNaN(sale)) return null;

    const afterEmag = sale * (1 - pct / 100);
    const buy = Number(pretCumparare);
    const buyCost =
      pretCumparare == null || pretCumparare === "" || Number.isNaN(buy) ? 0 : buy;
    const other = parseAlteCosturi(alteCosturi);

    return afterEmag - buyCost - other;
  }

  function calcPretMinimProfit(
    pretCumparare,
    alteCosturi = DEFAULT_ALTE_COSTURI,
    pctEmag
  ) {
    if (pctEmag == null || pctEmag === "") return null;
    const pct = Number(pctEmag);
    if (Number.isNaN(pct) || pct >= 100) return null;

    const buy = Number(pretCumparare);
    const buyCost =
      pretCumparare == null || pretCumparare === "" || Number.isNaN(buy) ? 0 : buy;
    const costs = buyCost + parseAlteCosturi(alteCosturi);
    const factor = 1 - pct / 100;
    if (factor <= 0) return null;

    return roundPrice(costs / factor);
  }

  function calcProcentajProfit(
    salePrice,
    pretCumparare,
    alteCosturi = DEFAULT_ALTE_COSTURI,
    pctEmag
  ) {
    const profit = calcProfit(salePrice, pretCumparare, alteCosturi, pctEmag);
    const minProfit = calcPretMinimProfit(pretCumparare, alteCosturi, pctEmag);
    if (profit == null || minProfit == null) return null;
    if (!Number.isFinite(profit) || !Number.isFinite(minProfit) || minProfit === 0) {
      return null;
    }
    return (profit / minProfit) * 100;
  }

  function saleFromProcentaj(
    procentaj,
    pretCumparare,
    alteCosturi = DEFAULT_ALTE_COSTURI,
    pctEmag
  ) {
    if (procentaj == null || procentaj === "" || pctEmag == null || pctEmag === "") {
      return null;
    }
    const pctEmagVal = Number(pctEmag);
    const pctTarget = Number(procentaj);
    if (Number.isNaN(pctTarget) || Number.isNaN(pctEmagVal) || pctEmagVal >= 100) {
      return null;
    }

    const factor = 1 - pctEmagVal / 100;
    if (factor <= 0) return null;

    const minProfit = calcPretMinimProfit(pretCumparare, alteCosturi, pctEmagVal);
    if (minProfit == null || !Number.isFinite(minProfit)) return null;

    const buy = Number(pretCumparare);
    const buyCost =
      pretCumparare == null || pretCumparare === "" || Number.isNaN(buy) ? 0 : buy;
    const costs = buyCost + parseAlteCosturi(alteCosturi);

    return roundPrice((costs + (pctTarget / 100) * minProfit) / factor);
  }

  /* ---------- comision ---------- */

  function isEmagCommissionFetched(commissionValue) {
    return commissionValue != null && Number(commissionValue) > 0;
  }

  function formatProcentajEmagDisplay(pct) {
    if (pct == null || !Number.isFinite(Number(pct))) return "—";
    const n = Number(pct);
    const formatted = Number.isInteger(n) ? String(n) : n.toFixed(2);
    return `${formatted} %`;
  }

  function procentajEmagTooltip(commissionValue, fetchedAt) {
    const parts = [];
    if (commissionValue != null && Number.isFinite(Number(commissionValue))) {
      parts.push(`Comision: ${Number(commissionValue).toFixed(2)} RON`);
    }
    if (fetchedAt) {
      try {
        parts.push(`preluat ${new Date(fetchedAt).toLocaleString("ro-RO")}`);
      } catch {
        parts.push(`preluat ${fetchedAt}`);
      }
    }
    return parts.length ? parts.join(" · ") : "";
  }

  function procentajEmagInputHtml(value, showReset = false) {
    const val =
      value == null || !Number.isFinite(Number(value))
        ? DEFAULT_PROcentaj_EMAG
        : Number(value);
    return `<div class="procentaj-emag-wrap"><input type="number" class="input-procentaj-emag" min="0" max="100" step="0.01" value="${escapeHtml(val)}" /><span class="procentaj-emag-suffix" aria-hidden="true">%</span><button type="button" class="btn-reset-emag-pct"${showReset ? "" : " hidden"} aria-label="Revine la 25%">×</button></div>`;
  }

  /* ---------- persistare listing ---------- */

  /** Salveaza un subset de campuri pe listing-ul canalului dat. */
  async function patchListing(channel, offerId, fields) {
    const id = String(offerId ?? "").trim();
    if (!id) return null;
    const res = await fetch(
      `/api/catalog/listing/${encodeURIComponent(id)}?channel=${encodeURIComponent(channel)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data.listing || null;
  }

  /**
   * Debounce per (oferta, camp) — ultima valoare tastata castiga.
   * getChannel() e citit la momentul salvarii, nu la creare.
   */
  function createPersister({ getChannel, onSaved, onError }) {
    const timers = new Map();
    return function schedulePersistListing(offerId, fields, label) {
      const id = String(offerId ?? "");
      if (!id) return;
      const key = `${id}:${Object.keys(fields).sort().join(",")}`;
      const prev = timers.get(key);
      if (prev) clearTimeout(prev);
      timers.set(
        key,
        setTimeout(async () => {
          timers.delete(key);
          try {
            await patchListing(getChannel(), id, fields);
            if (onSaved) onSaved(id, fields);
          } catch (err) {
            console.error(`[${label || "listing"}] salvare eșuată:`, err.message);
            if (onError) onError(err);
          }
        }, 300)
      );
    };
  }

  global.Pricing = {
    DEFAULT_ALTE_COSTURI,
    DEFAULT_PROcentaj_EMAG,
    PCT_LEVEL_CLASSES,
    escapeHtml,
    formatPrice,
    formatPercent,
    daysSince,
    relativeTimeRo,
    stalenessClass,
    procentajLevelClass,
    formatStatus,
    numOrNull,
    parseJsonAttr,
    parseSortNumber,
    parseAlteCosturi,
    roundPrice,
    pricesEqual,
    stockSumFromArr,
    alteFromProcentaj,
    calcProfit,
    calcPretMinimProfit,
    calcProcentajProfit,
    saleFromProcentaj,
    isEmagCommissionFetched,
    formatProcentajEmagDisplay,
    procentajEmagTooltip,
    procentajEmagInputHtml,
    patchListing,
    createPersister,
  };
})(window);
