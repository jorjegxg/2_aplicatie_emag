/**
 * Browserul boților: Chrome-ul de pe PC (profil separat, fereastră vizibilă, pornit de systemd —
 * vezi scripts/bot-chrome/), legat prin CDP la BOT_CHROME_CDP. Dacă e oprit, cădem pe un Chromium
 * headless în container (eMAG îl blochează des) și rezultatele spun asta.
 *
 * Doar citire, impus aici: pe taburile boților orice cerere în afară de GET / HEAD / OPTIONS e oprită,
 * deci nu pleacă formulare, comenzi sau salvări. Taburile tale din același Chrome nu sunt atinse.
 * Fiecare cerere a botului își deschide tabul ei și îl închide la final. Pauză între navigări.
 */
const SITES = { ro: "https://www.emag.ro", hu: "https://www.emag.hu", bg: "https://www.emag.bg" };
const CDP = String(process.env.BOT_CHROME_CDP || "").trim();
const PAUSE_MS = 4000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;
const TEXT_MAX = 20_000;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

let pcPromise = null; // Chrome-ul de pe PC
let localPromise = null; // rezerva headless
let idleTimer = null;
let lastNav = 0;

async function connectPc() {
  if (!CDP) return null;
  if (!pcPromise) {
    const { chromium } = require("playwright");
    pcPromise = chromium.connectOverCDP(CDP, { timeout: 8000 }).then(
      (b) => {
        b.on("disconnected", () => (pcPromise = null));
        return b;
      },
      (e) => {
        pcPromise = null;
        throw e;
      }
    );
  }
  return pcPromise;
}

async function launchLocal() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(closeLocal, IDLE_CLOSE_MS);
  if (!localPromise) {
    const { chromium } = require("playwright");
    localPromise = chromium.launch({ headless: true }).catch((e) => {
      localPromise = null;
      throw e;
    });
  }
  return localPromise;
}

async function closeLocal() {
  const p = localPromise;
  localPromise = null;
  if (p) await (await p).close().catch(() => {});
}

/** Deconectare la oprirea serviciului: Chrome-ul de pe PC rămâne pornit. */
async function close() {
  const p = pcPromise;
  pcPromise = null;
  // La CDP, close() doar rupe legătura; browserul de pe PC merge mai departe.
  if (p) await (await p).close().catch(() => {});
  await closeLocal();
}

/** Tab nou cu paza de doar-citire → { page, rezerva }. `rezerva` = textul de spus când nu e Chrome-ul de pe PC. */
async function newTab() {
  let page;
  let rezerva = null;
  try {
    const b = await connectPc();
    if (b) page = await (b.contexts()[0] || (await b.newContext())).newPage();
  } catch (e) {
    rezerva = `Chrome-ul de pe PC nu răspunde (${e.message.split("\n")[0]}), folosesc browserul de rezervă`;
  }
  if (!page) {
    if (!rezerva) rezerva = "Chrome-ul de pe PC nu e configurat, folosesc browserul de rezervă";
    const ctx = await (await launchLocal()).newContext({ locale: "ro-RO" });
    page = await ctx.newPage();
    page.once("close", () => ctx.close().catch(() => {}));
  }
  await page.route("**/*", (route) => (READ_METHODS.has(route.request().method()) ? route.continue() : route.abort("blockedbyclient")));
  return { page, rezerva };
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
  const { page, rezerva } = await newTab();
  const extra = rezerva ? { browser: rezerva } : {};
  const sugestii = new Set();
  page.on("response", async (res) => {
    if (!/suggest|autocomplete/i.test(res.url())) return;
    try {
      const json = await res.json();
      const walk = (v) => {
        if (typeof v === "string" && v.length > 2 && v.length < 80) sugestii.add(v.trim().toLowerCase());
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") ["term", "name", "text", "value", "query", "queries", "suggestions", "items", "data"].forEach((k) => walk(v[k]));
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
    if (!home || isBlocked(home.status(), homeText)) return { url: site, blocat: true, status: home?.status() ?? null, ...extra };

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
    if (!res || isBlocked(res.status(), text)) return { url, blocat: true, status: res?.status() ?? null, ...extra };

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
      ...extra,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Un tab al botului pentru o cerere către Claude (uneltele browser_*). Se deschide la prima folosire
 * și se închide cu close(), la sfârșitul cererii.
 */
class Tab {
  constructor() {
    this.tab = null;
  }

  async page() {
    if (!this.tab || this.tab.page.isClosed()) this.tab = await newTab();
    return this.tab.page;
  }

  /** Ce vede botul: adresa, titlul, textul paginii și linkurile principale. */
  async read(status = null) {
    const page = await this.page();
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const data = await page.evaluate(() => {
      const links = [];
      const seen = new Set();
      for (const a of document.querySelectorAll("a[href]")) {
        const text = (a.innerText || a.getAttribute("title") || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
        if (!text || text.length > 120 || !/^https?:/.test(a.href) || seen.has(a.href)) continue;
        seen.add(a.href);
        links.push({ text, href: a.href });
        if (links.length >= 80) break;
      }
      return { titlu: document.title, text: document.body?.innerText || "", linkuri: links };
    });
    const out = {
      url: page.url(),
      status,
      titlu: data.titlu,
      blocat: status != null && isBlocked(status, data.text),
      text: data.text.replace(/\n{3,}/g, "\n\n").slice(0, TEXT_MAX),
      text_taiat: data.text.length > TEXT_MAX,
      linkuri: data.linkuri,
    };
    if (this.tab.rezerva) out.browser = this.tab.rezerva;
    return out;
  }

  async open(url) {
    const page = await this.page();
    await pace();
    const res = await page.goto(/^https?:\/\//i.test(url) ? url : `https://${url}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return this.read(res?.status() ?? null);
  }

  /** Click pe un link / buton după textul lui (sau un selector CSS). */
  async click(target) {
    const page = await this.page();
    const candidates = [
      page.getByRole("link", { name: target }),
      page.getByRole("button", { name: target }),
      page.getByText(target),
      ...(/^[#.\[a-z]/i.test(target) ? [page.locator(target)] : []),
    ];
    for (const loc of candidates) {
      const el = loc.first();
      if (!(await el.count().catch(() => 0))) continue;
      await pace();
      await el.click({ timeout: 8000 });
      return this.read();
    }
    throw new Error(`Nu găsesc pe pagină „${target}”`);
  }

  /** Scrie în bara de căutare a site-ului și apasă Enter. */
  async searchHere(text) {
    const page = await this.page();
    const box = page
      .locator('input[type="search"], input[name="q"], textarea[name="q"], input[name="query"], input[name="search"], input[placeholder*="aut" i]')
      .first();
    if (!(await box.count())) throw new Error("Pagina nu are o bară de căutare pe care s-o găsesc");
    await pace();
    await box.click({ timeout: 5000 }).catch(() => {});
    await box.fill("");
    await box.pressSequentially(text, { delay: 80 });
    await page.waitForTimeout(1200);
    await box.press("Enter");
    return this.read();
  }

  async back() {
    const page = await this.page();
    const res = await page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 });
    return this.read(res?.status() ?? null);
  }

  /** Captură JPEG a ecranului vizibil. */
  async screenshot() {
    const page = await this.page();
    return page.screenshot({ type: "jpeg", quality: 60 });
  }

  async close() {
    const t = this.tab;
    this.tab = null;
    if (t) await t.page.close().catch(() => {});
  }
}

/** Starea Chrome-ului de pe PC, fără să deschidă nimic: { configurat, conectat, versiune, taburi }. */
async function status() {
  if (!CDP) return { configurat: false, conectat: false };
  try {
    const [v, list] = await Promise.all(
      ["/json/version", "/json/list"].map((p) => fetch(CDP.replace(/\/$/, "") + p, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()))
    );
    return { configurat: true, conectat: true, versiune: v.Browser, taburi: list.filter((t) => t.type === "page").length };
  } catch (e) {
    return { configurat: true, conectat: false, eroare: e.cause?.code || e.message };
  }
}

module.exports = { search, close, status, Tab };
