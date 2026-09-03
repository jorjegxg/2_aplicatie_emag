/**
 * Adaptor canal eMAG. Tot HTTP-ul catre marketplace-ul eMAG trece pe aici;
 * server.js nu mai stie de forma raspunsului eMAG.
 */
const {
  EMAG_API,
  ITEMS_PER_PAGE,
  emagFetch,
  loadCredentials,
  authHeader,
  authCandidates,
  savePreferredAuthLabel,
  logAuthAttempt,
  logAuthResult,
} = require("../emag-client");

const EMAG_API_V1 = "https://marketplace-api.emag.ro/api/v1";

const id = "emag";
const label = "eMAG";

/* ---------------- normalizare ---------------- */

function formatCharacteristics(characteristics) {
  if (!Array.isArray(characteristics) || characteristics.length === 0) {
    return "";
  }
  return characteristics
    .map((c) => {
      const name = c.name || c.id || "?";
      const value = Array.isArray(c.value) ? c.value.join(", ") : c.value ?? "";
      return `${name}: ${value}`;
    })
    .join("; ");
}

function normalizeStock(stock, generalStock) {
  if (Array.isArray(stock) && stock.length > 0) {
    return stock.map((s) => ({
      warehouse_id: Number(s.warehouse_id) || 1,
      value: Number(s.value) || 0,
    }));
  }
  const qty = Number(generalStock);
  return [{ warehouse_id: 1, value: Number.isFinite(qty) ? qty : 0 }];
}

function normalizeHandlingTime(handlingTime) {
  if (Array.isArray(handlingTime) && handlingTime.length > 0) {
    return handlingTime.map((h) => ({
      warehouse_id: Number(h.warehouse_id) || 1,
      value: Number(h.value) || 0,
    }));
  }
  return [{ warehouse_id: 1, value: 0 }];
}

/** Oferta eMAG bruta -> forma canonica folosita de snapshot/listing. */
function mapOffer(offer) {
  const ean = Array.isArray(offer.ean) ? offer.ean.join(", ") : offer.ean || "";
  const fam = Array.isArray(offer.family) ? offer.family[0] : offer.family;
  return {
    id: offer.id,
    name: offer.name || "",
    description: offer.description || "",
    brand: offer.brand || offer.brand_name || "",
    part_number: offer.part_number || "",
    part_number_key: offer.part_number_key || "",
    id_familie: fam?.id ?? null,
    familie: fam?.name || "",
    sale_price: offer.sale_price ?? null,
    recommended_price: offer.recommended_price ?? null,
    min_sale_price: offer.min_sale_price ?? null,
    max_sale_price: offer.max_sale_price ?? null,
    currency: offer.currency || "RON",
    general_stock: offer.general_stock ?? null,
    estimated_stock: offer.estimated_stock ?? null,
    status: offer.status,
    vat_id: offer.vat_id ?? null,
    handling_time: normalizeHandlingTime(offer.handling_time),
    stock: normalizeStock(offer.stock, offer.general_stock),
    ean,
    characteristics: formatCharacteristics(offer.characteristics),
  };
}

/* ---------------- HTTP ---------------- */

async function productOfferRead(auth, page) {
  const body = new URLSearchParams();
  body.set("currentPage", String(page));
  body.set("itemsPerPage", String(ITEMS_PER_PAGE));

  const response = await emagFetch(`${EMAG_API}/product_offer/read`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, json, text };
}

async function productOfferSave(auth, offers) {
  console.log(
    `[eMAG update] POST ${EMAG_API}/product_offer/save — ${offers.length} oferte`
  );
  console.log(
    "[eMAG update] body:",
    JSON.stringify(
      offers.map((o) => ({
        id: o.id,
        name: o.name,
        sale_price: o.sale_price,
        recommended_price: o.recommended_price,
        min_sale_price: o.min_sale_price,
        max_sale_price: o.max_sale_price,
        status: o.status,
        vat_id: o.vat_id,
      }))
    )
  );

  const response = await emagFetch(`${EMAG_API}/product_offer/save`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: offers }),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  console.log(`[eMAG update] HTTP ${response.status}`);
  if (json) {
    console.log(
      `[eMAG update] isError=${Boolean(json.isError)} messages=`,
      json.messages || []
    );
  } else {
    console.log("[eMAG update] răspuns non-JSON:", text.slice(0, 500));
  }
  return { response, json, text };
}

async function commissionEstimate(auth, offerId) {
  const response = await emagFetch(`${EMAG_API_V1}/commission/estimate/${offerId}`, {
    method: "GET",
    headers: { Authorization: auth },
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, json, text };
}

function parseCommissionPercent(json) {
  const raw =
    json?.data?.value ?? json?.data?.commission ?? json?.value ?? json?.commission;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

function commissionValueFromPercent(percent, salePrice) {
  const pct = Number(percent);
  const sale = Number(salePrice);
  if (!Number.isFinite(pct) || !Number.isFinite(sale) || sale <= 0) return null;
  return Math.round(sale * (pct / 100) * 100) / 100;
}

/** Incearca fiecare combinatie de credentiale pana una nu da 401/403. */
async function resolveAuth(context, probeFn) {
  const creds = loadCredentials();
  const candidates = authCandidates(creds);
  console.log(
    `[auth:${context}] ordine încercări:`,
    candidates.map((c) => c.label).join(" → ")
  );

  let lastStatus = null;
  let lastDetail = "";

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    logAuthAttempt(context, candidate, i, candidates.length);
    const auth = authHeader(candidate.user, candidate.pass);
    const probe = await probeFn(auth);
    lastStatus = probe.status;
    lastDetail = probe.detail || "";

    if (probe.status === 401 || probe.status === 403) {
      logAuthResult(context, candidate, probe.status, false);
      continue;
    }

    if (probe.ok) {
      logAuthResult(context, candidate, probe.status, true);
      savePreferredAuthLabel(candidate.label);
      return { auth, label: candidate.label, probe };
    }

    // Non-auth error (5xx, raspuns invalid) — nu are rost sa incerc alt user.
    logAuthResult(context, candidate, probe.status, false);
    const err = new Error(probe.detail || `eMAG HTTP ${probe.status}`);
    err.status = probe.status;
    err.messages = probe.messages || [];
    throw err;
  }

  const err = new Error(
    "Autentificare eMAG eșuată (401/403). Verifică credentials și IP whitelist."
  );
  err.status = lastStatus || 401;
  err.detail = String(lastDetail).slice(0, 300);
  throw err;
}

/* ---------------- interfata de canal ---------------- */

/** Citeste o pagina de oferte. -> { listings, hasMore, page, authUsed } */
async function fetchListings({ page = 1 } = {}) {
  let payload = null;
  const { label: authUsed } = await resolveAuth("products", async (auth) => {
    const { response, json, text } = await productOfferRead(auth, page);
    if (response.status === 401 || response.status === 403) {
      return { status: response.status, ok: false, detail: text };
    }
    if (!json) {
      return {
        status: response.status,
        ok: false,
        detail: `Răspuns invalid de la eMAG: ${text.slice(0, 300)}`,
      };
    }
    if (json.isError) {
      return {
        status: response.status,
        ok: false,
        detail: "eMAG a returnat eroare",
        messages: json.messages || [],
      };
    }
    payload = json;
    return { status: response.status, ok: true };
  });

  const results = Array.isArray(payload?.results) ? payload.results : [];
  const listings = results.map(mapOffer);
  return {
    listings,
    page,
    itemsPerPage: ITEMS_PER_PAGE,
    hasMore: listings.length >= ITEMS_PER_PAGE,
    authUsed,
  };
}

/** Trimite ofertele catre eMAG. -> { count, authUsed, messages } */
async function pushListings(offers) {
  if (!Array.isArray(offers) || offers.length === 0) {
    throw new Error("Nicio ofertă de sincronizat");
  }
  console.log(`[sync-prices] start — ${offers.length} oferte de updatat pe eMAG`);

  let result = null;
  const { label: authUsed } = await resolveAuth("sync-prices", async (auth) => {
    const { response, json, text } = await productOfferSave(auth, offers);
    if (response.status === 401 || response.status === 403) {
      return { status: response.status, ok: false, detail: text };
    }
    if (!json) {
      return {
        status: response.status,
        ok: false,
        detail: `Răspuns invalid de la eMAG: ${text.slice(0, 300)}`,
      };
    }
    if (json.isError) {
      return {
        status: 502,
        ok: false,
        detail: "eMAG a returnat eroare la salvare prețuri",
        messages: json.messages || [],
      };
    }
    result = json;
    return { status: response.status, ok: true };
  });

  console.log(
    `[sync-prices] OK — updatate ${offers.length} oferte pe eMAG (auth=${authUsed})`,
    offers.map((o) => ({ id: o.id, sale_price: o.sale_price }))
  );
  return { count: offers.length, authUsed, messages: result?.messages || [] };
}

/** Construieste payload-ul de push din valorile mele. Arunca daca lipsesc campuri. */
function buildPushPayload(listing) {
  const toNum = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const invalid = (message) => {
    const err = new Error(message);
    err.status = 400;
    return err;
  };

  const id = toNum(listing?.id);
  const sale_price = toNum(listing?.sale_price);
  const status = toNum(listing?.status);
  const vat_id = toNum(listing?.vat_id);
  const recommended_price = toNum(listing?.recommended_price);
  const min_sale_price = toNum(listing?.min_sale_price);
  const max_sale_price = toNum(listing?.max_sale_price);

  if (id == null || sale_price == null) {
    throw invalid(
      `Oferta ${id ?? "?"}: lipsește prețul de vânzare — preia întâi ofertele de la eMAG`
    );
  }
  if (status == null || vat_id == null) {
    throw invalid(`Oferta ${id}: lipsesc status sau vat_id — preia întâi ofertele de la eMAG`);
  }
  if (recommended_price != null && recommended_price <= sale_price) {
    throw invalid(
      `Oferta ${id}: PRP (${recommended_price}) trebuie să fie mai mare decât pretul de vânzare (${sale_price})`
    );
  }

  const payload = {
    id,
    status,
    sale_price,
    vat_id,
    handling_time: normalizeHandlingTime(listing?.handling_time),
    stock: normalizeStock(listing?.stock, listing?.general_stock),
  };
  const name = typeof listing?.name === "string" ? listing.name.trim() : "";
  if (name) payload.name = name;
  if (listing?.description != null) payload.description = listing.description;
  if (recommended_price != null) payload.recommended_price = recommended_price;
  if (min_sale_price != null) payload.min_sale_price = min_sale_price;
  if (max_sale_price != null) payload.max_sale_price = max_sale_price;
  return payload;
}

/** Comision estimat per oferta. -> { procentaj, commission_value } */
async function fetchCommission(auth, externalId, salePrice) {
  const { response, json, text } = await commissionEstimate(auth, externalId);
  if (response.status === 401 || response.status === 403) {
    throw new Error("autentificare eMAG eșuată");
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  }
  const procentaj_emag = parseCommissionPercent(json);
  if (procentaj_emag == null) {
    throw new Error(json?.message || "răspuns fără comision");
  }
  const commission_value = commissionValueFromPercent(procentaj_emag, salePrice);
  if (commission_value == null) {
    throw new Error("comision RON invalid");
  }
  return { procentaj_emag, commission_value };
}

/** Auth pentru un batch de comisioane — probe pe primul id. */
async function resolveCommissionAuth(probeOfferId) {
  const { auth } = await resolveAuth("commission", async (authValue) => {
    const { response, json, text } = await commissionEstimate(authValue, probeOfferId);
    const pct = parseCommissionPercent(json);
    return {
      status: response.status,
      ok: response.ok && pct != null,
      detail: text,
    };
  });
  return auth;
}

module.exports = {
  id,
  label,
  ITEMS_PER_PAGE,
  mapOffer,
  normalizeStock,
  normalizeHandlingTime,
  formatCharacteristics,
  fetchListings,
  pushListings,
  buildPushPayload,
  fetchCommission,
  resolveCommissionAuth,
  resolveAuth,
};
