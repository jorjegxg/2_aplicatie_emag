/**
 * Test izolat: schimbă DOAR numele unei oferte eMAG (cu diacritice),
 * ocolind UI-ul aplicației — ca să vezi dacă eMAG acceptă update-ul de nume.
 *
 * Citește oferta, păstrează preț/stoc/status/vat/handling, trimite name nou.
 *
 * Utilizare (din backend/):
 *   node scripts/test-emag-name-diacritics.js
 *   node scripts/test-emag-name-diacritics.js --offer-id 2
 *   node scripts/test-emag-name-diacritics.js --dry-run
 *   node scripts/test-emag-name-diacritics.js --name "Titlu nou cu ăîâșț"
 *
 * Rulează de pe IP-ul whitelisted la eMAG.
 */
const {
  EMAG_API,
  emagFetch,
  loadCredentials,
  authHeader,
  authCandidates,
  savePreferredAuthLabel,
  logAuthAttempt,
  logAuthResult,
} = require("../emag-client");

const DIACRITICS_MARKER = " [testă ăĂîÎâÂșȘțȚ]";

function parseArgs(argv) {
  const args = { offerId: "2", dryRun: false, name: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--offer-id") args.offerId = String(argv[++i] || "").trim() || "2";
    else if (a === "--name") args.name = String(argv[++i] ?? "");
  }
  return args;
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

function withDiacritics(currentName) {
  const base = String(currentName || "").trim() || "Produs test";
  const stripped = base.replace(/\s*\[testă[^\]]*\]\s*$/i, "").trim();
  return `${stripped}${DIACRITICS_MARKER}`;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { text, json };
}

async function productOfferReadById(auth, offerId) {
  const body = new URLSearchParams();
  body.set("currentPage", "1");
  body.set("itemsPerPage", "10");
  body.set("id", String(offerId));

  const response = await emagFetch(`${EMAG_API}/product_offer/read`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const { text, json } = await parseJsonResponse(response);
  return { response, json, text };
}

async function productOfferSave(auth, offers) {
  const response = await emagFetch(`${EMAG_API}/product_offer/save`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: offers }),
  });
  const { text, json } = await parseJsonResponse(response);
  return { response, json, text };
}

async function resolveAuth(offerId) {
  const creds = await loadCredentials();
  const candidates = authCandidates(creds);
  console.log(`[auth] ordine: ${candidates.map((c) => c.label).join(" → ")}`);

  let lastStatus = null;
  let lastDetail = "";

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    logAuthAttempt("test-name", candidate, i, candidates.length);
    const auth = authHeader(candidate.user, candidate.pass);
    const { response, json, text } = await productOfferReadById(auth, offerId);
    lastStatus = response.status;
    lastDetail = text.slice(0, 300);

    if (response.status === 401 || response.status === 403) {
      logAuthResult("test-name", candidate, response.status, false);
      continue;
    }

    if (!json || json.isError) {
      logAuthResult("test-name", candidate, response.status, false);
      const err = new Error(
        `Citire eMAG eșuată: ${JSON.stringify(json?.messages || text.slice(0, 200))}`
      );
      err.status = response.status;
      throw err;
    }

    logAuthResult("test-name", candidate, response.status, true);
    savePreferredAuthLabel(candidate.label);
    return { auth, label: candidate.label, json };
  }

  const err = new Error(
    `Autentificare eMAG eșuată (HTTP ${lastStatus || "?"}). ${lastDetail}`
  );
  err.status = lastStatus || 401;
  throw err;
}

function pickOffer(json, offerId) {
  const results = Array.isArray(json?.results) ? json.results : [];
  const want = String(offerId);
  const hit = results.find((o) => String(o?.id) === want);
  if (hit) return hit;
  if (results.length === 1) return results[0];
  return null;
}

function buildSavePayload(offer, newName) {
  const id = Number(offer.id);
  const sale_price = Number(offer.sale_price);
  const status = Number(offer.status);
  const vat_id = Number(offer.vat_id);

  if (!Number.isFinite(id)) throw new Error("Oferta fără id numeric");
  if (!Number.isFinite(sale_price)) throw new Error("Oferta fără sale_price");
  if (!Number.isFinite(status)) throw new Error("Oferta fără status");
  if (!Number.isFinite(vat_id)) throw new Error("Oferta fără vat_id");

  const payload = {
    id,
    status,
    sale_price,
    vat_id,
    handling_time: normalizeHandlingTime(offer.handling_time),
    stock: normalizeStock(offer.stock, offer.general_stock),
    name: newName,
  };

  // păstrăm și limitele de preț dacă există, ca să nu le resetăm accidental
  for (const key of ["recommended_price", "min_sale_price", "max_sale_price"]) {
    const n = Number(offer[key]);
    if (Number.isFinite(n)) payload[key] = n;
  }

  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n=== Test update NUME (diacritice) — oferta eMAG id=${args.offerId} ===\n`);

  const { auth, label, json: readJson } = await resolveAuth(args.offerId);
  const offer = pickOffer(readJson, args.offerId);
  if (!offer) {
    console.error(
      `Oferta ${args.offerId} nu a fost găsită. results=${(readJson?.results || []).length}`
    );
    console.error(JSON.stringify(readJson, null, 2).slice(0, 1500));
    process.exit(1);
  }

  const oldName = String(offer.name || "");
  const newName =
    args.name != null && args.name !== "" ? args.name : withDiacritics(oldName);

  console.log("Auth:", label);
  console.log("PNK:", offer.part_number_key || "(gol)");
  console.log("ownership:", offer.ownership ?? "(necunoscut)");
  console.log("validation_status:", offer.validation_status ?? "(necunoscut)");
  console.log("sale_price:", offer.sale_price);
  console.log("status / vat_id:", offer.status, "/", offer.vat_id);
  console.log("Nume vechi:", oldName);
  console.log("Nume nou:  ", newName);
  console.log("");

  const payload = buildSavePayload(offer, newName);
  console.log("Payload trimis la product_offer/save:");
  console.log(JSON.stringify(payload, null, 2));
  console.log("");

  if (args.dryRun) {
    console.log("[dry-run] Nu am trimis nimic către eMAG.");
    return;
  }

  const { response, json, text } = await productOfferSave(auth, [payload]);
  console.log(`HTTP ${response.status}`);
  console.log("isError:", json ? Boolean(json.isError) : "(non-JSON)");
  console.log("messages:", JSON.stringify(json?.messages ?? [], null, 2));
  if (!json) {
    console.log("body:", text.slice(0, 1000));
  } else {
    console.log("results:", JSON.stringify(json.results ?? [], null, 2).slice(0, 2000));
  }

  console.log("\nInterpretare:");
  if (json?.isError) {
    console.log(
      "- eMAG a raportat eroare. Conform docs, oferta (preț) poate fi totuși salvată,"
    );
    console.log("  iar documentația (nume) respinsă — verifică messages/doc_errors.");
  } else {
    console.log(
      "- Răspuns OK. Așteaptă 5–10 min, apoi verifică pe site / panoul seller."
    );
    console.log(
      "  Dacă pe site rămâne numele vechi → limita e la eMAG (ownership/moderare), nu la app."
    );
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
