(function (window) {
  "use strict";

  const Pricing = window.Pricing;
  const Calc = window.Calculator;
  const escapeHtml = Pricing.escapeHtml;
  const LANGS = [
    { key: "ro", label: "RO" },
    { key: "hu", label: "HU" },
    { key: "bg", label: "BG" },
    { key: "en", label: "EN" },
  ];
  // Pe mobil, eMAG arată cam primele 50 de caractere din titlu.
  const MOBILE_TITLE_CHARS = 50;

  const els = {
    status: document.getElementById("base-status"),
    q: document.getElementById("base-q"),
    list: document.getElementById("base-list"),
    detail: document.getElementById("base-detail"),
  };
  let products = [];
  let baseStatus = null;
  let calcParams = null;
  let current = null; // { product, texts, images, preview, trendyol_commission_pct }
  let currentLang = "ro";

  function request(url, options) {
    return fetch(url, options).then((r) =>
      r.json().then((body) => {
        if (!r.ok) throw new Error(body.error || "HTTP " + r.status);
        return body;
      })
    );
  }

  function sendJson(method, url, body) {
    return request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function num(v) {
    if (v === "" || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  const lei = (v) => (v == null || !Number.isFinite(v) ? "—" : Pricing.formatPrice(v, "RON"));
  const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : Pricing.formatPercent(v * 100));
  const signClass = (v) => (v == null || !Number.isFinite(v) ? "" : v < 0 ? "is-neg" : "is-pos");

  /** Aceeasi transformare ca textToHtml din backend: paragrafe la rand gol, <br> la rand nou. */
  function textToHtml(text) {
    const normalized = String(text || "").replace(/\r\n?/g, "\n").trim();
    if (!normalized) return "";
    return normalized
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .filter(Boolean)
      .map((b) => "<p>" + escapeHtml(b).split("\n").join("<br>") + "</p>")
      .join(" ");
  }

  /* ---------------- stare Base ---------------- */

  function renderStatus() {
    const s = baseStatus;
    if (!s) return;
    if (!s.configured) {
      els.status.textContent = "BASE_TOKEN lipsește din .env — aplicația nu poate vorbi cu Base.";
      els.status.className = "base-status is-bad";
      return;
    }
    if (s.error) {
      els.status.textContent = "Base nu răspunde: " + s.error;
      els.status.className = "base-status is-bad";
      return;
    }
    const inv = s.inventory;
    const integ = (s.integrations || []).map((i) => i.name + " (" + i.code + ")").join(", ") || "niciuna";
    const parts = [
      "Catalog Base: " + (inv ? inv.name + " #" + inv.inventory_id : "negăsit"),
      "limbi " + (inv ? inv.languages.join(", ").toUpperCase() : "—"),
      "integrări: " + integ,
      s.send_enabled ? "trimiterea e PORNITĂ" : "trimiterea e oprită (BASE_SEND=0): butonul arată doar ce ar pleca",
    ];
    els.status.textContent = parts.join(" · ");
    els.status.className = "base-status " + (s.send_enabled ? "is-live" : "is-dry");
  }

  /* ---------------- lista ---------------- */

  function productState(p) {
    if (!p.base_product_id) return { cls: "st-none", text: "netrimis" };
    return { cls: "st-linked", text: "în Base" };
  }

  function renderList() {
    const q = els.q.value.trim().toLowerCase();
    const shown = products.filter(
      (p) => !q || String(p.cod_produs || "").toLowerCase().includes(q) || String(p.nume || "").toLowerCase().includes(q)
    );
    els.list.innerHTML = shown
      .map((p) => {
        const st = productState(p);
        const langs = LANGS.map((l) => {
          const img = p.images[l.key] || 0;
          const txt = p.texts[l.key] === true;
          const cls = img && txt ? "ok" : img || txt ? "half" : "none";
          const title = l.label + ": " + img + " poze, " + (txt ? "are text" : "fără text");
          return '<span class="base-lang base-lang--' + cls + '" title="' + escapeHtml(title) + '">' + l.label + "</span>";
        }).join("");
        return (
          '<li><button type="button" class="base-item' +
          (current && current.product.id === p.id ? " is-active" : "") +
          '" data-id="' + p.id + '">' +
          (p.thumb ? '<img src="' + escapeHtml(p.thumb) + '" alt="" loading="lazy" />' : '<span class="base-thumb-empty"></span>') +
          '<span class="base-item-text"><strong>' + escapeHtml(p.cod_produs || "#" + p.id) + "</strong>" +
          '<span class="base-item-name">' + escapeHtml(p.nume || "") + "</span>" +
          '<span class="base-item-badges">' + langs +
          '<span class="base-state ' + st.cls + '">' + st.text + "</span></span></span></button></li>"
        );
      })
      .join("");
  }

  /* ---------------- detaliu ---------------- */

  function calcFor(channel, prices) {
    const p = current.product;
    return Calc.calcProduct(
      {
        pret_fabrica: prices.pret_fabrica,
        moneda: p.moneda_fabrica || "USD",
        greutate: p.greutate,
        latime: p.latime,
        lungime: p.lungime,
        inaltime: p.inaltime,
        pret_vanzare: prices.sale,
        comision_emag: channel === "trendyol" ? prices.ty_pct : prices.emag_pct,
      },
      Calc.paramsForChannel(calcParams, channel)
    );
  }

  function readPriceInputs() {
    const v = (name) => num(els.detail.querySelector('[name="' + name + '"]').value);
    return {
      sale: v("sale_price"),
      min: v("min_sale_price"),
      max: v("max_sale_price"),
      stock: v("general_stock"),
      pret_fabrica: v("pret_cumparare_usd"),
      emag_pct: v("procentaj_emag") ?? Pricing.DEFAULT_PROcentaj_EMAG,
      ty_pct: v("trendyol_pct") ?? v("procentaj_emag") ?? Pricing.DEFAULT_PROcentaj_EMAG,
    };
  }

  function renderProfit() {
    const prices = readPriceInputs();
    const rows = [
      ["eMAG", calcFor("emag", prices)],
      ["Trendyol", calcFor("trendyol", prices)],
    ];
    const body = rows
      .map(([label, out]) => {
        if (!out) {
          return "<tr><th>" + label + '</th><td colspan="5" class="muted">lipsește prețul de fabrică sau greutatea</td></tr>';
        }
        return (
          "<tr><th>" + label + "</th>" +
          '<td class="' + signClass(out.profit_tren) + '">' + lei(out.profit_tren) + "</td>" +
          '<td class="' + signClass(out.procent_profit_tren) + '">' + pct(out.procent_profit_tren) + "</td>" +
          '<td class="' + signClass(out.profit_aer) + '">' + lei(out.profit_aer) + "</td>" +
          '<td class="' + signClass(out.procent_profit_aer) + '">' + pct(out.procent_profit_aer) + "</td>" +
          "<td>" + lei(out.break_even_tren) + "</td></tr>"
        );
      })
      .join("");
    els.detail.querySelector("#base-profit-body").innerHTML = body;
  }

  function priceField(name, label, value, attrs) {
    // DB-ul intoarce NUMERIC ca text ("43.9800"); in camp apare numarul curat (43.98).
    const shown = num(value) == null ? "" : String(num(value));
    return (
      '<label class="field"><span>' + label + "</span>" +
      '<input type="number" step="0.01" name="' + name + '" value="' + escapeHtml(shown) + '" ' + (attrs || "") + " /></label>"
    );
  }

  function renderPrices() {
    const p = current.product;
    const tyPct = current.trendyol_commission_pct;
    return (
      '<section class="base-card"><h2>Prețuri și profit</h2>' +
      '<div class="base-price-grid">' +
      priceField("sale_price", "Preț vânzare (lei)", p.sale_price) +
      priceField("min_sale_price", "Preț minim", p.min_sale_price) +
      priceField("max_sale_price", "Preț maxim", p.max_sale_price) +
      priceField("general_stock", "Stoc", p.general_stock, 'step="1"') +
      priceField("pret_cumparare_usd", "Preț fabrică (" + escapeHtml(p.moneda_fabrica || "USD") + ")", p.pret_cumparare_usd) +
      priceField("procentaj_emag", "Comision eMAG %", p.procentaj_emag, p.emag_offer_id ? "" : 'readonly title="Fără ofertă eMAG legată"') +
      priceField(
        "trendyol_pct",
        "Comision Trendyol %",
        tyPct,
        'placeholder="gol = ca eMAG" title="Din ultima preluare Trendyol (Sincronizare → Preia); doar pentru calcul"'
      ) +
      priceField("target_pct", "Profit Tren dorit %", "", 'placeholder="ex. 25" title="Calculează prețul de vânzare"') +
      "</div>" +
      '<div class="base-profit-wrap"><table class="base-profit"><thead><tr><th></th><th>Profit Tren</th><th>% Tren</th><th>Profit Aer</th><th>% Aer</th><th>Break-even Tren</th></tr></thead>' +
      '<tbody id="base-profit-body"></tbody></table></div>' +
      '<div class="base-actions"><button type="button" class="btn" data-action="save-prices">Salvează prețurile</button>' +
      '<span class="status" id="base-price-status" role="status"></span></div>' +
      "</section>"
    );
  }

  function effectiveImages(lang) {
    const own = current.images[lang] || [];
    if (own.length) return { source: lang, list: own };
    return { source: "en", list: current.images.en || [] };
  }

  function renderLangTab() {
    const lang = currentLang;
    const t = current.texts[lang] || {};
    const imgs = effectiveImages(lang);
    const fallbackNote =
      imgs.source !== lang && lang !== "en"
        ? '<p class="base-note">' + lang.toUpperCase() + " nu are poze proprii — se văd pozele EN.</p>"
        : "";
    const baseNote =
      lang !== "ro"
        ? '<p class="base-note">În Base pleacă o singură galerie: cea RO. Galeria ' + lang.toUpperCase() + " rămâne de referință în aplicație.</p>"
        : "";
    const gallery = imgs.list.length
      ? imgs.list
          .map(
            (img, i) =>
              '<a class="base-photo" href="' + escapeHtml(img.url) + '" target="_blank" rel="noopener" title="Deschide la 100%">' +
              '<img src="' + escapeHtml(img.url) + '" alt="Poza ' + (i + 1) + '" loading="lazy" /><span>' + (i + 1) + "</span></a>"
          )
          .join("")
      : '<p class="muted">Nicio poză.</p>';
    const inBase = (baseStatus?.inventory?.languages || ["ro"]).includes(lang);
    return (
      '<div class="base-tab-body">' +
      fallbackNote + baseNote +
      '<div class="base-gallery">' + gallery + "</div>" +
      '<div class="base-texts">' +
      '<label class="field base-field-full"><span>Titlu <em id="base-title-count"></em></span>' +
      '<input type="text" name="text_name" value="' + escapeHtml(t.name || "") + '" /></label>' +
      '<p class="base-mobile-title" title="Ce se vede pe mobil"><span id="base-title-mobile"></span><span class="base-title-rest" id="base-title-rest"></span></p>' +
      '<div class="base-desc-row">' +
      '<label class="field base-field-full"><span>Descriere (text simplu; rând gol = paragraf nou)</span>' +
      '<textarea name="text_description" rows="16">' + escapeHtml(t.description || "") + "</textarea></label>" +
      '<div class="base-desc-preview"><span class="muted">Cum arată</span><div id="base-desc-html"></div></div>' +
      "</div>" +
      (inBase ? "" : '<p class="base-note">Limba ' + lang.toUpperCase() + " nu e în catalogul Base: textele se salvează aici, dar nu pleacă.</p>") +
      '<div class="base-actions"><button type="button" class="btn" data-action="save-texts">Salvează textele ' + lang.toUpperCase() + "</button>" +
      '<span class="status" id="base-text-status" role="status"></span></div>' +
      "</div></div>"
    );
  }

  function updateTextPreview() {
    const name = els.detail.querySelector('[name="text_name"]');
    const desc = els.detail.querySelector('[name="text_description"]');
    if (!name || !desc) return;
    const v = name.value;
    els.detail.querySelector("#base-title-count").textContent = "(" + v.length + " caractere)";
    els.detail.querySelector("#base-title-mobile").textContent = v.slice(0, MOBILE_TITLE_CHARS);
    els.detail.querySelector("#base-title-rest").textContent = v.length > MOBILE_TITLE_CHARS ? v.slice(MOBILE_TITLE_CHARS) : "";
    els.detail.querySelector("#base-desc-html").innerHTML = textToHtml(desc.value) || '<span class="muted">—</span>';
  }

  function renderPreview() {
    const pv = current.preview;
    const warnings = pv.warnings.length
      ? '<ul class="base-warnings">' + pv.warnings.map((w) => "<li>" + escapeHtml(w) + "</li>").join("") + "</ul>"
      : '<p class="base-ok">Nimic lipsă.</p>';
    const link = pv.link?.base_product_id
      ? "Legat de produsul Base #" + pv.link.base_product_id + (pv.link.last_pushed_at ? ", trimis ultima dată " + new Date(pv.link.last_pushed_at).toLocaleString("ro-RO") : "")
      : "Încă nu e în Base (se caută după SKU, apoi după EAN; dacă nu există, se creează).";
    const fields = Object.keys(pv.payload.text_fields).join(", ") || "—";
    return (
      '<section class="base-card"><h2>Ce pleacă în Base</h2>' +
      "<p>" + escapeHtml(link) + "</p>" +
      '<p class="muted">' + (pv.changed ? "S-a schimbat față de ultima trimitere." : "La fel ca la ultima trimitere.") +
      " Texte: " + escapeHtml(fields) + " · " + Object.keys(pv.payload.images).length + " poze (" + escapeHtml(String(pv.image_source).toUpperCase()) + ")</p>" +
      warnings +
      '<details><summary>Payload</summary><pre class="base-payload">' + escapeHtml(JSON.stringify(pv.payload, null, 2)) + "</pre></details>" +
      '<div class="base-actions"><button type="button" class="btn btn-push" data-action="push">' +
      (baseStatus?.send_enabled ? "Trimite în Base" : "Arată ce ar pleca în Base") +
      '</button><span class="status" id="base-push-status" role="status"></span></div>' +
      "</section>"
    );
  }

  function renderDetail() {
    if (!current) return;
    const p = current.product;
    const tabs = LANGS.map((l) => {
      const n = (current.images[l.key] || []).length;
      return (
        '<button type="button" role="tab" class="base-tab' + (l.key === currentLang ? " is-active" : "") +
        '" aria-selected="' + (l.key === currentLang) + '" data-lang="' + l.key + '">' + l.label +
        ' <small>' + n + " poze</small></button>"
      );
    }).join("");
    els.detail.innerHTML =
      '<header class="base-detail-head"><h2>' + escapeHtml(p.cod_produs || "#" + p.id) + "</h2>" +
      '<p class="muted">' + escapeHtml(p.nume || "") + (p.ean ? " · EAN " + escapeHtml(p.ean) : "") + "</p></header>" +
      renderPrices() +
      '<section class="base-card"><h2>Poze și texte pe limbi</h2>' +
      '<div class="base-tabs" role="tablist">' + tabs + "</div>" +
      '<div id="base-tab">' + renderLangTab() + "</div></section>" +
      '<div id="base-preview">' + renderPreview() + "</div>";
    renderProfit();
    updateTextPreview();
  }

  function loadDetail(id) {
    return request("/api/base/product/" + id).then((data) => {
      current = data;
      renderDetail();
      renderList();
    });
  }

  function refreshPreview() {
    return request("/api/base/product/" + current.product.id).then((data) => {
      current.preview = data.preview;
      current.texts = data.texts;
      els.detail.querySelector("#base-preview").innerHTML = renderPreview();
    });
  }

  function setStatus(id, text, bad) {
    const el = els.detail.querySelector("#" + id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-error", Boolean(bad));
  }

  /* ---------------- acțiuni ---------------- */

  function savePrices() {
    const p = current.product;
    const v = readPriceInputs();
    const fields = {
      sale_price: v.sale,
      min_sale_price: v.min,
      max_sale_price: v.max,
      general_stock: v.stock,
      pret_cumparare_usd: v.pret_fabrica,
    };
    setStatus("base-price-status", "Se salvează…");
    const jobs = [sendJson("PATCH", "/api/catalog/product/" + p.id, { fields })];
    const emagPct = num(els.detail.querySelector('[name="procentaj_emag"]').value);
    if (p.emag_offer_id && emagPct !== num(p.procentaj_emag)) {
      jobs.push(
        sendJson("PATCH", "/api/catalog/listing/" + encodeURIComponent(p.emag_offer_id) + "?channel=emag", {
          fields: { procentaj_emag: emagPct },
        })
      );
    }
    Promise.all(jobs)
      .then(() => {
        Object.assign(p, fields, { procentaj_emag: emagPct });
        const item = products.find((x) => x.id === p.id);
        if (item) Object.assign(item, { sale_price: v.sale, general_stock: v.stock });
        setStatus("base-price-status", "Salvat.");
        return refreshPreview();
      })
      .catch((err) => setStatus("base-price-status", err.message, true));
  }

  function saveTexts() {
    const lang = currentLang;
    const body = {
      name: els.detail.querySelector('[name="text_name"]').value,
      description: els.detail.querySelector('[name="text_description"]').value,
      characteristics: current.texts[lang]?.characteristics ?? null,
    };
    setStatus("base-text-status", "Se salvează…");
    sendJson("PUT", "/api/base/product/" + current.product.id + "/texts/" + lang, body)
      .then((res) => {
        current.texts = res.texts;
        const item = products.find((x) => x.id === current.product.id);
        if (item) {
          item.texts[lang] = Boolean(body.name.trim() && body.description.trim());
          if (lang === "ro") item.nume = body.name;
        }
        renderList();
        setStatus("base-text-status", "Salvat.");
        return refreshPreview();
      })
      .catch((err) => setStatus("base-text-status", err.message, true));
  }

  function push() {
    setStatus("base-push-status", "Se pregătește…");
    request("/api/base/product/" + current.product.id + "/push", { method: "POST" })
      .then((res) => {
        if (res.dry_run) {
          setStatus("base-push-status", "Nu s-a trimis nimic (BASE_SEND=0). Payload-ul de mai sus e exact ce ar pleca.");
          return;
        }
        const item = products.find((x) => x.id === current.product.id);
        if (item) item.base_product_id = res.base_product_id;
        renderList();
        return refreshPreview().then(() =>
          setStatus("base-push-status", (res.created ? "Creat" : "Actualizat") + " în Base (#" + res.base_product_id + ").")
        );
      })
      .catch((err) => setStatus("base-push-status", err.message, true));
  }

  els.list.addEventListener("click", (e) => {
    const btn = e.target.closest("button.base-item");
    if (btn) loadDetail(Number(btn.dataset.id)).catch((err) => (els.detail.textContent = err.message));
  });

  els.q.addEventListener("input", renderList);

  els.detail.addEventListener("click", (e) => {
    const tab = e.target.closest("button.base-tab");
    if (tab) {
      currentLang = tab.dataset.lang;
      els.detail.querySelectorAll("button.base-tab").forEach((b) => {
        b.classList.toggle("is-active", b === tab);
        b.setAttribute("aria-selected", String(b === tab));
      });
      els.detail.querySelector("#base-tab").innerHTML = renderLangTab();
      updateTextPreview();
      return;
    }
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "save-prices") savePrices();
    else if (action === "save-texts") saveTexts();
    else if (action === "push") push();
  });

  els.detail.addEventListener("input", (e) => {
    if (e.target.name === "text_name" || e.target.name === "text_description") {
      updateTextPreview();
      return;
    }
    if (e.target.name === "target_pct") {
      const target = num(e.target.value);
      if (target == null) return;
      const v = readPriceInputs();
      const p = current.product;
      const price = Calc.pretPentruProcentTren(
        {
          pret_fabrica: v.pret_fabrica,
          moneda: p.moneda_fabrica || "USD",
          greutate: p.greutate,
          latime: p.latime,
          lungime: p.lungime,
          inaltime: p.inaltime,
          comision_emag: v.emag_pct,
        },
        Calc.paramsForChannel(calcParams, "emag"),
        target / 100
      );
      e.target.classList.toggle("is-invalid", price == null);
      if (price != null) els.detail.querySelector('[name="sale_price"]').value = String(Math.round(price * 100) / 100);
    }
    if (e.target.closest(".base-price-grid")) renderProfit();
  });

  Promise.all([
    request("/api/base/status").catch((err) => ({ configured: true, error: err.message })),
    request("/api/settings"),
    request("/api/base/products"),
  ])
    .then(([status, settings, list]) => {
      baseStatus = status;
      calcParams = settings.calculator_params;
      products = list.products;
      renderStatus();
      renderList();
      // ?id=<produs> din „Produse”; ?ext=<oferta eMAG sau barcode Trendyol> din „Sincronizare”.
      const params = new URLSearchParams(window.location.search);
      const ext = params.get("ext");
      const match = ext ? products.find((p) => String(p.emag_offer_id) === ext || String(p.ean) === ext) : null;
      const fromUrl = Number(params.get("id")) || match?.id;
      if (fromUrl) return loadDetail(fromUrl);
    })
    .catch((err) => {
      els.status.textContent = "Eroare: " + err.message;
      els.status.className = "base-status is-bad";
    });
})(window);
