/**
 * Adaptor canal Trendyol — Product V2 (V1 a fost retras pe 10.08.2026; apelurile
 * vechi raspund 426 UpgradeRequired).
 *
 * Persistenta locala e doar pe eMAG (catalog_products + override-uri pe
 * marketplace_listings). Ofertele Trendyol traiesc doar in oglinda remote din
 * memorie (channel-remote-cache), umpluta de /api/sync/pull.
 *
 * Endpoint-uri folosite (baza https://apigw.trendyol.com/integration):
 *   GET  /product/sellers/{id}/products/approved|unapproved — pull
 *   POST /inventory/sellers/{id}/products/price-and-inventory — pret/stoc
 *   POST /product/sellers/{id}/products/content-bulk-update — titlu/descriere
 *   filtre pull: ?barcode= / ?stockCode=, paginare 0-based (?page=&size=)
 * Auth: Basic base64(apiKey:apiSecret) + User-Agent "{sellerId} - SelfIntegration".
 * Header obligatoriu: storeFrontCode (RO = piața / moneda storefront-ului).
 * Accept-Language: limba titlu/descriere/categorii (ro pe RO; fără el API-ul
 * întoarce adesea engleză). Override: TRENDYOL_ACCEPT_LANGUAGE.
 * Credentiale: Setări → Trendyol (SUPPLIER_ID, API_KEY, API_SECRET) în DB criptat.
 */

const {
  isTrendyolConfigured,
  credentialsMissingError,
  getTrendyolCreds,
} = require("../credentials-store");
const { htmlToText } = require("../description-format");

const id = "trendyol";
const label = "Trendyol";

const TRENDYOL_API = "https://apigw.trendyol.com/integration";
/** Storefront = piață / monedă; limba conținutului e Accept-Language. */
const STOREFRONT_CODE = String(
  process.env.TRENDYOL_STOREFRONT_CODE || "RO"
).toUpperCase();
const CURRENCY_BY_STOREFRONT = { RO: "RON", TR: "TRY", GR: "EUR", DE: "EUR" };
const LANGUAGE_BY_STOREFRONT = { RO: "ro", GR: "el", TR: "en", DE: "en" };
const ACCEPT_LANGUAGE = String(
  process.env.TRENDYOL_ACCEPT_LANGUAGE ||
    LANGUAGE_BY_STOREFRONT[STOREFRONT_CODE] ||
    "ro"
).toLowerCase();
const ITEMS_PER_PAGE = 100;
const REQUEST_TIMEOUT_MS = 30000;

async function requireConfigured() {
  if (!(await isTrendyolConfigured())) {
    throw credentialsMissingError(
      "trendyol",
      "Credentiale Trendyol lipsă. Mergi la Setări (sus-dreapta) și setează Supplier ID, API Key și API Secret."
    );
  }
  return getTrendyolCreds();
}

function authHeaders(creds) {
  const basic = Buffer.from(
    `${creds.API_KEY}:${creds.API_SECRET}`
  ).toString("base64");
  return {
    Authorization: `Basic ${basic}`,
    "User-Agent": `${creds.SUPPLIER_ID} - SelfIntegration`,
    Accept: "application/json",
    storeFrontCode: STOREFRONT_CODE,
    "Accept-Language": ACCEPT_LANGUAGE,
  };
}

/** Cerere HTTP pe API-ul Trendyol; ridica eroare cu .status pastrat pentru sendChannelError. */
async function trendyolRequest(creds, method, path, { params = {}, body } = {}) {
  const url = new URL(`${TRENDYOL_API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && String(v) !== "") url.searchParams.set(k, String(v));
  }

  const headers = authHeaders(creds);
  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    const err = new Error(`Trendyol: cerere eșuată — ${cause.message}`);
    err.status = 502;
    throw err;
  }

  const text = await response.text();
  if (!response.ok) {
    const err = new Error(trendyolErrorMessage(response.status, text));
    err.status = response.status;
    err.detail = text.slice(0, 300);
    throw err;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(
      `Trendyol: răspuns invalid — ${text.slice(0, 200)}`
    );
    err.status = 502;
    throw err;
  }
}

async function trendyolGet(creds, path, params = {}) {
  return trendyolRequest(creds, "GET", path, { params });
}

async function trendyolPost(creds, path, body) {
  return trendyolRequest(creds, "POST", path, { body });
}

/** Mesajele Trendyol vin in `errors[].message`; 401/426 merita text explicit. */
function trendyolErrorMessage(status, text) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* raspuns non-JSON (ex. pagina Cloudflare) */
  }
  const detail = Array.isArray(parsed?.errors)
    ? parsed.errors.map((e) => e.message).filter(Boolean).join("; ")
    : "";

  if (status === 401 || status === 403) {
    return "Trendyol: autentificare eșuată (401/403). Verifică API Key și API Secret în Setări.";
  }
  if (status === 426) {
    return `Trendyol: endpoint retras, e nevoie de Product V2. ${detail}`.trim();
  }
  return detail
    ? `Trendyol HTTP ${status}: ${detail}`
    : `Trendyol HTTP ${status}`;
}

/* ---------------- normalizare ---------------- */

/**
 * Product V2: content + variants[]. Status numeric 1 = vandabil pe canal
 * (aprobat, onSale, ne-arhivat / ne-blocat / ne-blacklist).
 */
function mapStatus(bucket, variant) {
  if (String(bucket) !== "approved") return 0;
  if (!variant) return 0;
  if (variant.archived || variant.blacklisted || variant.locked) return 0;
  return variant.onSale === true ? 1 : 0;
}

function formatAttributes(attributes) {
  if (!Array.isArray(attributes) || attributes.length === 0) return "";
  return attributes
    .map((a) => {
      const name = a.attributeName || a.attributeId || "?";
      const value = a.attributeValue ?? "";
      return `${name}: ${value}`;
    })
    .join("; ");
}

function normalizeImages(images) {
  return (Array.isArray(images) ? images : [])
    .map((im) => ({ url: String(im?.url || "").trim(), display_type: 0 }))
    .filter((im) => /^https?:\/\//i.test(im.url));
}

function toNumOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function approvalStatusLabel(bucket, variant) {
  if (String(bucket) !== "approved") return "unapproved";
  if (variant?.archived) return "archived";
  if (variant?.blacklisted) return "blacklisted";
  if (variant?.locked) return "locked";
  if (variant?.onSale === true) return "approved";
  return "approved_not_on_sale";
}

/**
 * Content Product V2 + o varianta -> forma canonica de listing (ca eMAG).
 * Identitatea externa e barcode-ul variantei (filtrele API-ului il folosesc).
 * Pret/stoc/SKU vin din variant; titlu/descriere/brand din content.
 */
function mapVariant(content, variant, bucket) {
  const quantity = toNumOrNull(variant?.stock?.quantity);
  const barcode = String(variant?.barcode ?? "").trim();
  const contentAttrs = formatAttributes(content?.attributes);
  const variantAttrs = formatAttributes(variant?.attributes);
  const characteristics = [contentAttrs, variantAttrs].filter(Boolean).join("; ");

  return {
    id: barcode,
    name: content?.title || "",
    description: htmlToText(content?.description),
    brand: content?.brand?.name || "",
    part_number: variant?.stockCode || content?.productMainId || "",
    part_number_key: "",
    id_familie: null,
    familie: content?.category?.name || "",
    sale_price: toNumOrNull(variant?.price?.salePrice),
    recommended_price: toNumOrNull(variant?.price?.listPrice),
    min_sale_price: null,
    max_sale_price: null,
    currency: CURRENCY_BY_STOREFRONT[STOREFRONT_CODE] || "RON",
    general_stock: quantity,
    estimated_stock: null,
    status: mapStatus(bucket, variant),
    vat_id: null,
    vat_rate: toNumOrNull(variant?.vatRate),
    handling_time: [{ warehouse_id: 1, value: 0 }],
    stock: [{ warehouse_id: 1, value: quantity ?? 0 }],
    ean: barcode,
    characteristics,
    images: normalizeImages(content?.images),
    approval_status: approvalStatusLabel(bucket, variant),
    reject_reasons: (content?.rejectReasonDetails || variant?.rejectReasonDetails || [])
      .map((r) => r.reason || r.name || "")
      .filter(Boolean),
    content_id: content?.contentId ?? null,
    variant_id: variant?.variantId ?? null,
    commission_rate: toNumOrNull(variant?.commission),
  };
}

/** Compat: raspuns vechi flat (barcode pe produs) sau Product V2 cu variants[]. */
function mapContentToListings(content, bucket) {
  if (!content || typeof content !== "object") return [];
  const variants = Array.isArray(content.variants) ? content.variants : [];
  if (variants.length > 0) {
    const out = [];
    for (const variant of variants) {
      if (!variant?.barcode) continue;
      out.push(mapVariant(content, variant, bucket));
    }
    return out;
  }
  // Shape vechi / fallback: barcode + pret pe content.
  if (!content.barcode) return [];
  return [
    mapVariant(
      content,
      {
        barcode: content.barcode,
        stockCode: content.stockCode,
        vatRate: content.vatRate,
        onSale: String(content.status || "").toLowerCase() === "approved",
        stock: { quantity: content.quantity },
        price: {
          salePrice: content.salePrice,
          listPrice: content.listPrice,
        },
        rejectReasonDetails: content.rejectReasonDetails,
      },
      bucket
    ),
  ];
}

/* ---------------- interfata de canal ---------------- */

const LISTING_BUCKETS = ["approved", "unapproved"];

/** Filtrele pe care le accepta API-ul Trendyol pentru o citire punctuala. */
function readFilters(filters) {
  if (!filters || typeof filters !== "object") return {};
  const out = {};
  // `id` din aplicatie e barcode-ul Trendyol (vezi mapProduct).
  const barcode = filters.id ?? filters.barcode;
  if (barcode != null && String(barcode).trim() !== "") {
    out.barcode = String(barcode).trim();
  }
  const stockCode = filters.part_number ?? filters.stockCode;
  if (!out.barcode && stockCode != null && String(stockCode).trim() !== "") {
    out.stockCode = String(stockCode).trim();
  }
  return out;
}

/**
 * Citeste o pagina de produse. Aprobate si neaprobate stau pe endpoint-uri
 * separate, deci cer aceeasi pagina din fiecare si le concatenez; `hasMore` e
 * adevarat cat timp oricare dintre ele mai are pagini.
 * -> { listings, hasMore, page, itemsPerPage }
 */
async function fetchListings({ page = 1, filters } = {}) {
  const creds = await requireConfigured();
  const extra = readFilters(filters);
  const filtered = Object.keys(extra).length > 0;
  // Paginarea Trendyol e 0-based, a aplicatiei 1-based.
  const apiPage = Math.max(0, Number(page) - 1);

  const listings = [];
  let hasMore = false;

  for (const bucket of LISTING_BUCKETS) {
    const payload = await trendyolGet(
      creds,
      `/product/sellers/${creds.SUPPLIER_ID}/products/${bucket}`,
      { page: apiPage, size: ITEMS_PER_PAGE, ...extra }
    );
    const content = Array.isArray(payload?.content) ? payload.content : [];
    for (const product of content) {
      listings.push(...mapContentToListings(product, bucket));
    }
    if (!filtered && Number(payload?.totalPages) > apiPage + 1) hasMore = true;
  }

  return {
    listings,
    page,
    itemsPerPage: filtered ? listings.length : ITEMS_PER_PAGE,
    hasMore: filtered ? false : hasMore,
    authUsed: `trendyol:${creds.SUPPLIER_ID}/${STOREFRONT_CODE}/${ACCEPT_LANGUAGE}`,
  };
}

const TITLE_MAX_LEN = 100;
const PUSH_CHUNK_SIZE = 1000;

function invalidPush(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Catalog SoT (pret/stoc/nume) + oglinda remote (content_id, preturi curente pe canal).
 * Identitate = barcode.
 */
function mergeLocalWithRemoteCache(local, remote) {
  const id = String(local?.id ?? remote?.id ?? "").trim();
  if (!remote) {
    const err = new Error(
      `Oferta ${id || "?"}: lipsește oglinda remote — preia întâi ofertele de la Trendyol`
    );
    err.status = 400;
    throw err;
  }
  const qty = Number(local?.general_stock);
  return {
    id,
    barcode: id,
    name: local?.name,
    description: local?.description,
    sale_price: local?.sale_price,
    recommended_price: local?.recommended_price,
    general_stock: Number.isFinite(qty) ? qty : 0,
    content_id: remote.content_id ?? null,
    remote_sale_price: remote.sale_price,
    remote_list_price: remote.recommended_price,
  };
}

/**
 * Payload intern de push: { id, inventory?, content? }.
 * inventory → POST .../price-and-inventory; content → POST .../content-bulk-update.
 * Trendyol nu are min/max; PRP = listPrice.
 */
function buildPushPayload(
  listing,
  {
    includeContent = false,
    includeName = false,
    includeDescription = false,
    includeSalePrice = false,
    includeRecommendedPrice = false,
    includeStock = false,
    includeMinSalePrice: _min = false,
    includeMaxSalePrice: _max = false,
  } = {}
) {
  const barcode = String(listing?.id ?? listing?.barcode ?? "").trim();
  if (!barcode) throw invalidPush("Ofertă fără barcode — nu pot publica pe Trendyol");

  const wantName = includeContent || includeName;
  const wantDescription = includeContent || includeDescription;
  const wantSale = includeSalePrice;
  const wantList = includeRecommendedPrice;
  const wantStock = includeStock;

  if (!wantName && !wantDescription && !wantSale && !wantList && !wantStock) {
    throw invalidPush(`Oferta ${barcode}: nimic de publicat`);
  }

  const payload = { id: barcode };

  if (wantSale || wantList || wantStock) {
    const inventory = { barcode };
    if (wantStock) {
      const qty = toNum(listing?.general_stock);
      inventory.quantity = qty == null ? 0 : Math.max(0, Math.floor(qty));
    }
    if (wantSale) {
      const salePrice = toNum(listing?.sale_price);
      if (salePrice == null) {
        throw invalidPush(
          `Oferta ${barcode}: lipsește prețul de vânzare — completează-l în catalog`
        );
      }
      inventory.salePrice = salePrice;
    }
    if (wantList) {
      const listPrice = toNum(listing?.recommended_price);
      if (listPrice == null) {
        throw invalidPush(
          `Oferta ${barcode}: lipsește PRP (listPrice) — completează-l în catalog`
        );
      }
      inventory.listPrice = listPrice;
    }

    // listPrice nu poate fi sub salePrice (regula Trendyol).
    const effectiveSale =
      inventory.salePrice ??
      toNum(listing?.sale_price) ??
      toNum(listing?.remote_sale_price);
    let effectiveList =
      inventory.listPrice ??
      toNum(listing?.recommended_price) ??
      toNum(listing?.remote_list_price);

    if (
      wantSale &&
      !wantList &&
      inventory.salePrice != null &&
      effectiveList != null &&
      effectiveList < inventory.salePrice
    ) {
      // Ridicăm listPrice la noul sale ca să nu eșueze batch-ul.
      inventory.listPrice = inventory.salePrice;
      effectiveList = inventory.salePrice;
    }

    if (
      effectiveSale != null &&
      effectiveList != null &&
      effectiveList < effectiveSale
    ) {
      throw invalidPush(
        `Oferta ${barcode}: PRP/listPrice (${effectiveList}) trebuie ≥ prețul de vânzare (${effectiveSale})`
      );
    }

    payload.inventory = inventory;
    if (inventory.salePrice != null) payload.sale_price = inventory.salePrice;
  }

  if (wantName || wantDescription) {
    const contentId = toNum(listing?.content_id);
    if (contentId == null) {
      throw invalidPush(
        `Oferta ${barcode}: lipsește contentId — preia întâi ofertele de la Trendyol`
      );
    }
    const content = { contentId };
    if (wantName) {
      const title = typeof listing?.name === "string" ? listing.name.trim() : "";
      if (!title) {
        throw invalidPush(`Oferta ${barcode}: titlu gol — completează numele în catalog`);
      }
      if (title.length > TITLE_MAX_LEN) {
        throw invalidPush(
          `Oferta ${barcode}: titlul are ${title.length} caractere (maxim ${TITLE_MAX_LEN} pe Trendyol)`
        );
      }
      content.title = title;
    }
    if (wantDescription && listing?.description != null) {
      const description = String(listing.description).trim();
      if (description) content.description = description;
    }
    if (content.title != null || content.description != null) {
      payload.content = content;
    }
  }

  return payload;
}

/** Trimite loturi de pret/stoc și/sau content. -> { count, authUsed, batchRequestIds, messages } */
async function pushListings(offers) {
  if (!Array.isArray(offers) || offers.length === 0) {
    throw new Error("Nicio ofertă de sincronizat");
  }
  const creds = await requireConfigured();
  console.log(
    `[sync-prices] start — ${offers.length} oferte de updatat pe Trendyol`
  );

  const inventoryItems = [];
  const contentById = new Map();
  for (const o of offers) {
    if (o?.inventory) inventoryItems.push(o.inventory);
    if (o?.content?.contentId != null) {
      const cid = o.content.contentId;
      const prev = contentById.get(cid) || { contentId: cid };
      if (o.content.title != null) prev.title = o.content.title;
      if (o.content.description != null) prev.description = o.content.description;
      contentById.set(cid, prev);
    }
  }
  const contentItems = [...contentById.values()];

  const batchRequestIds = [];
  const messages = [];
  const seller = creds.SUPPLIER_ID;

  async function postChunks(label, path, items) {
    for (let i = 0; i < items.length; i += PUSH_CHUNK_SIZE) {
      const chunk = items.slice(i, i + PUSH_CHUNK_SIZE);
      console.log(
        `[sync-prices] Trendyol ${label} lot ${Math.floor(i / PUSH_CHUNK_SIZE) + 1} — ${chunk.length} itemi`
      );
      const result = await trendyolPost(creds, path, { items: chunk });
      const batchId = result?.batchRequestId;
      if (batchId) batchRequestIds.push(batchId);
      else messages.push({ type: "warning", message: `${label}: fără batchRequestId` });
    }
  }

  if (inventoryItems.length > 0) {
    await postChunks(
      "price-and-inventory",
      `/inventory/sellers/${seller}/products/price-and-inventory`,
      inventoryItems
    );
  }
  if (contentItems.length > 0) {
    await postChunks(
      "content-bulk-update",
      `/product/sellers/${seller}/products/content-bulk-update`,
      contentItems
    );
  }

  const authUsed = `trendyol:${seller}/${STOREFRONT_CODE}/${ACCEPT_LANGUAGE}`;
  console.log(
    `[sync-prices] OK — ${offers.length} oferte pe Trendyol (auth=${authUsed}, batches=${batchRequestIds.length})`,
    offers.map((o) => ({
      id: o.id,
      sale_price: o.sale_price ?? o.inventory?.salePrice,
      contentId: o.content?.contentId,
    }))
  );
  return {
    count: offers.length,
    authUsed,
    batchRequestIds,
    messages,
  };
}

async function fetchCommission() {
  await requireConfigured();
  const err = new Error("Trendyol: comisionul nu e implementat încă");
  err.status = 501;
  throw err;
}

async function resolveCommissionAuth() {
  await requireConfigured();
  const err = new Error("Trendyol: comisionul nu e implementat încă");
  err.status = 501;
  throw err;
}

module.exports = {
  id,
  label,
  fetchListings,
  pushListings,
  buildPushPayload,
  mergeLocalWithRemoteCache,
  fetchCommission,
  resolveCommissionAuth,
};
