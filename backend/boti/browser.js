/**
 * Botul SEO deschide căutarea eMAG într-un Chromium (Playwright), ca un cumpărător.
 * Fără trucuri de ascundere: dacă site-ul refuză browserul automat (410 / 403 / captcha), întoarcem
 * { blocat: true } și botul lucrează fără date live. Pauză între pagini ca să nu încărcăm site-ul.
 */
const SITES = { ro: "https://www.emag.ro", hu: "https://www.emag.hu", bg: "https://www.emag.bg" };
const PAUSE_MS = 4000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;

let browserPromise = null;
let idleTimer = null;
let lastNav = 0;

async function browser() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(close, IDLE_CLOSE_MS);
  if (!browserPromise) {
    const { chromium } = require("playwright");
    browserPromise = chromium.launch({ headless: true }).catch((e) => {
      browserPromise = null;
      throw e;
    });
  }
  return browserPromise;
}

async function close() {
  const p = browserPromise;
  browserPromise = null;
  if (p) await (await p).close().catch(() => {});
}

async function pace() {
  const wait = lastNav + PAUSE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNav = Date.now();
}

function isBlocked(status, text) {
  return status === 403 || status === 410 || status === 429 || /captcha|access denied|acces restric/i.test(text.slice(0, 3000));
}

/**
 * Pagina de rezultate pentru `termen` → { url, blocat, nr_rezultate, categorii[], top[{titlu, pret}], sugestii[] }.
 * Sugestiile vin din răspunsurile JSON pe care le cere bara de căutare când tastezi.
 */
async function search(termen, tara = "ro") {
  const site = SITES[tara] || SITES.ro;
  const b = await browser();
  const ctx = await b.newContext({ locale: tara === "hu" ? "hu-HU" : tara === "bg" ? "bg-BG" : "ro-RO" });
  const page = await ctx.newPage();
  const sugestii = new Set();
  page.on("response", async (res) => {
    if (!/suggest|autocomplete/i.test(res.url())) return;
    try {
      const json = await res.json();
      const walk = (v) => {
        if (typeof v === "string" && v.length > 2 && v.length < 80) sugestii.add(v.trim().toLowerCase());
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") ["term", "name", "text", "value", "query", "suggestions", "items", "data"].forEach((k) => walk(v[k]));
      };
      walk(json);
    } catch {
      /* nu e JSON */
    }
  });
  try {
    await pace();
    const home = await page.goto(site, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const homeText = await page.evaluate(() => document.body?.innerText || "");
    if (!home || isBlocked(home.status(), homeText)) return { url: site, blocat: true, status: home?.status() ?? null };

    const box = page.locator('input[type="search"], input[name="query"], #searchboxTrigger').first();
    if (await box.count()) {
      await box.click({ timeout: 5000 }).catch(() => {});
      await box.pressSequentially(termen, { delay: 120 }).catch(() => {});
      await page.waitForTimeout(2500);
    }

    await pace();
    const url = `${site}/search/${encodeURIComponent(termen)}`;
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const text = await page.evaluate(() => document.body?.innerText || "");
    if (!res || isBlocked(res.status(), text)) return { url, blocat: true, status: res?.status() ?? null };

    const data = await page.evaluate(() => {
      const out = { top: [], categorii: [] };
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const j = JSON.parse(s.textContent);
          const items = (j.itemListElement || []).map((e) => e.item || e);
          for (const it of items.slice(0, 15)) out.top.push({ titlu: it.name, pret: it.offers?.price ?? it.offers?.lowPrice ?? null });
        } catch {
          /* ignore */
        }
      }
      if (!out.top.length) {
        for (const a of [...document.querySelectorAll("a")].filter((x) => /\/pd\//.test(x.href)).slice(0, 40)) {
          const t = (a.getAttribute("title") || a.textContent || "").trim();
          if (t.length > 15 && !out.top.some((x) => x.titlu === t)) out.top.push({ titlu: t, pret: null });
          if (out.top.length >= 15) break;
        }
      }
      for (const a of document.querySelectorAll('a[href*="/c?"], a[href$="/c"], a[href*="/sd?"]')) {
        const t = a.textContent.trim().replace(/\s+/g, " ");
        if (t && t.length < 80 && !out.categorii.includes(t)) out.categorii.push(t);
        if (out.categorii.length >= 12) break;
      }
      return out;
    });
    const m = /([\d.\s]+)\s+(?:de\s+)?rezultate/i.exec(text) || /([\d.\s]+)\s+(?:találat|резултат)/i.exec(text);
    return {
      url,
      blocat: false,
      nr_rezultate: m ? Number(m[1].replace(/[^\d]/g, "")) || null : null,
      categorii: data.categorii,
      top: data.top,
      sugestii: [...sugestii].slice(0, 20),
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

module.exports = { search, close };
