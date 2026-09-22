const { recordPretEmagIfChanged } = require("./db");
const { getListings, getChannelRemotes } = require("./marketplace-db");
const { getChannel } = require("./channels");

/** Eroare "asteptata" (validare) — raspuns JSON simplu, fara log de canal. */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expected = true;
  return err;
}

/**
 * Trimite catre canal: catalog SoT + status/vat/handling din oglinda remote.
 * `remotes` (Map id → remote) inlocuieste oglinda din cache — pentru push-uri punctuale
 * care nu trebuie sa scrie o oglinda partiala in cache.
 * `keepRemotePrice`: pretul trimis ramane cel de pe canal (eMAG cere mereu sale_price) —
 * push-ul automat de stoc nu publica modificari de pret nerevizuite.
 */
async function pushOffersForChannel(
  channelName,
  rawOffers,
  { includeContentAll = false, remotes = null, keepRemotePrice = false } = {}
) {
  const channel = getChannel(channelName);

  // Id-uri + flag-uri per câmp care diferă; valorile = catalog.
  // Compat: includeContent global/per-ofertă ⇒ name+description.
  const contentFlagsById = new Map();
  const ids = [];

  const emptyFlags = () => ({
    includeName: false,
    includeDescription: false,
    includeSalePrice: false,
    includeRecommendedPrice: false,
    includeMinSalePrice: false,
    includeMaxSalePrice: false,
    includeStock: false,
  });

  for (const o of rawOffers) {
    const isObj = o && typeof o === "object";
    const id = String((isObj ? o.id : o) ?? "").trim();
    if (!id) continue;
    ids.push(id);
    if (!isObj) {
      const flags = emptyFlags();
      if (includeContentAll) {
        flags.includeName = true;
        flags.includeDescription = true;
      }
      contentFlagsById.set(id, flags);
      continue;
    }
    const both = includeContentAll || o.includeContent === true;
    contentFlagsById.set(id, {
      includeName: both || o.includeName === true,
      includeDescription: both || o.includeDescription === true,
      includeSalePrice: o.includeSalePrice === true,
      includeRecommendedPrice: o.includeRecommendedPrice === true,
      includeMinSalePrice: o.includeMinSalePrice === true,
      includeMaxSalePrice: o.includeMaxSalePrice === true,
      includeStock: o.includeStock === true,
    });
  }

  if (ids.length === 0) {
    throw httpError(400, "Nicio ofertă de sincronizat");
  }

  const listings = await getListings(channelName, ids);
  if (listings.length === 0) {
    throw httpError(
      404,
      channelName === "trendyol"
        ? "Ofertele nu există în catalog — leagă EAN-ul produsului de barcode-ul Trendyol"
        : "Ofertele nu există în catalog — leagă emag_offer_id pe produs"
    );
  }

  const remoteCache = remotes ? { byId: remotes } : getChannelRemotes(channelName);
  if (!remoteCache) {
    throw httpError(
      400,
      `Lipsește oglinda ${channel.label} din memorie — preia întâi ofertele de la marketplace`
    );
  }

  if (typeof channel.mergeLocalWithRemoteCache !== "function") {
    throw httpError(501, `Canalul ${channel.label}: merge pentru publicare nu e implementat`);
  }

  const offers = [];
  for (const l of listings) {
    const effectiveMin =
      l.pret_minim_override != null && Number.isFinite(Number(l.pret_minim_override))
        ? Number(l.pret_minim_override)
        : l.min_sale_price;

    const remote = remoteCache.byId.get(String(l.external_id));
    const merged = channel.mergeLocalWithRemoteCache(
      {
        id: l.external_id,
        name: l.name,
        description: l.description,
        sale_price: keepRemotePrice && remote?.sale_price != null ? remote.sale_price : l.sale_price,
        recommended_price: l.recommended_price,
        min_sale_price: effectiveMin,
        max_sale_price: l.max_sale_price,
        general_stock: l.general_stock,
      },
      remote
    );
    const flags = contentFlagsById.get(String(l.external_id)) || emptyFlags();
    offers.push(channel.buildPushPayload(merged, flags));
  }

  const result = await channel.pushListings(offers);

  // Marketplace-urile proceseaza asincron — NU actualizam oglinda local;
  // confirmarea vine la urmatorul pull. Retinem doar istoricul de pret trimis.
  for (const o of offers) {
    const sale = o.sale_price ?? o.inventory?.salePrice;
    if (sale == null) continue;
    try {
      await recordPretEmagIfChanged(o.id, sale, "RON", "sync", channelName);
    } catch (histErr) {
      console.warn("[sync-prices] istoric pret:", histErr.message);
    }
  }

  return result;
}

module.exports = { httpError, pushOffersForChannel };
