const express = require("express");
const fs = require("fs");
const path = require("path");
const { lookupPretCumparare, getSettings, saveSettings } = require("./db");

const PORT = process.env.PORT || 3000;
const EMAG_API = "https://marketplace-api.emag.ro/api-3";
const ITEMS_PER_PAGE = 100;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function loadCredentials() {
  const filePath = path.join(__dirname, "credentials.json");
  if (!fs.existsSync(filePath)) {
    throw new Error("Lipsește credentials.json");
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw.USER_EMAIL || !raw.ACCOUNT_PASSWORD) {
    throw new Error("credentials.json trebuie să conțină USER_EMAIL și ACCOUNT_PASSWORD");
  }
  return raw;
}

function authHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function authCandidates(creds) {
  const list = [
    [creds.USER_EMAIL, creds.ACCOUNT_PASSWORD],
    [creds.USER_EMAIL, creds.API_CODE],
    [creds.API_CODE, creds.ACCOUNT_PASSWORD],
  ];
  return list.filter(([user, pass]) => user && pass);
}

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

function mapOffer(offer) {
  const ean = Array.isArray(offer.ean) ? offer.ean.join(", ") : offer.ean || "";
  const name = offer.name || "";
  const part_number = offer.part_number || "";
  return {
    id: offer.id,
    name,
    brand: offer.brand || offer.brand_name || "",
    part_number,
    part_number_key: offer.part_number_key || "",
    sale_price: offer.sale_price ?? null,
    recommended_price: offer.recommended_price ?? null,
    min_sale_price: offer.min_sale_price ?? null,
    max_sale_price: offer.max_sale_price ?? null,
    pret_cumparare: lookupPretCumparare(part_number, name),
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

async function emagProductOfferRead(auth, page) {
  const body = new URLSearchParams();
  body.set("currentPage", String(page));
  body.set("itemsPerPage", String(ITEMS_PER_PAGE));

  const response = await fetch(`${EMAG_API}/product_offer/read`, {
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

app.get("/api/settings", (_req, res) => {
  try {
    return res.json(getSettings());
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la citire setări" });
  }
});

app.post("/api/settings", (req, res) => {
  try {
    const toNum = (v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const saved = saveSettings({
      pret_transport: toNum(req.body?.pret_transport),
      pret_contabil: toNum(req.body?.pret_contabil),
      procentaj_emag: toNum(req.body?.procentaj_emag),
      numar_produse: toNum(req.body?.numar_produse),
      mult_prp: toNum(req.body?.mult_prp),
      mult_min: toNum(req.body?.mult_min),
      mult_max: toNum(req.body?.mult_max),
    });

    return res.json(saved);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la salvare setări" });
  }
});

async function emagProductOfferSave(auth, offers) {
  const response = await fetch(`${EMAG_API}/product_offer/save`, {
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

  return { response, json, text };
}

app.post("/api/products/sync-prices", async (req, res) => {
  try {
    const rawOffers = Array.isArray(req.body?.offers) ? req.body.offers : [];
    if (rawOffers.length === 0) {
      return res.status(400).json({ error: "Nicio ofertă de sincronizat" });
    }

    const toNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const offers = [];
    for (const o of rawOffers) {
      const id = toNum(o?.id);
      const sale_price = toNum(o?.sale_price);
      const recommended_price = toNum(o?.recommended_price);
      const min_sale_price = toNum(o?.min_sale_price);
      const max_sale_price = toNum(o?.max_sale_price);
      const status = toNum(o?.status);
      const vat_id = toNum(o?.vat_id);
      if (id == null || sale_price == null) {
        return res.status(400).json({
          error: "Fiecare ofertă trebuie să aibă id și sale_price valide",
        });
      }
      if (status == null || vat_id == null) {
        return res.status(400).json({
          error: `Oferta ${id}: lipsesc status sau vat_id (reîncarcă produsele)`,
        });
      }
      if (recommended_price != null && recommended_price <= sale_price) {
        return res.status(400).json({
          error: `Oferta ${id}: PRP (${recommended_price}) trebuie să fie mai mare decât pretul de vânzare (${sale_price})`,
        });
      }
      const stock = normalizeStock(o?.stock, o?.general_stock);
      const handling_time = normalizeHandlingTime(o?.handling_time);
      const payload = {
        id,
        status,
        sale_price,
        vat_id,
        handling_time,
        stock,
      };
      if (recommended_price != null) payload.recommended_price = recommended_price;
      if (min_sale_price != null) payload.min_sale_price = min_sale_price;
      if (max_sale_price != null) payload.max_sale_price = max_sale_price;
      offers.push(payload);
    }

    console.log(
      "[sync-prices] payload",
      JSON.stringify(
        offers.map((o) => ({
          id: o.id,
          sale_price: o.sale_price,
          recommended_price: o.recommended_price,
          min_sale_price: o.min_sale_price,
          max_sale_price: o.max_sale_price,
          status: o.status,
          vat_id: o.vat_id,
        }))
      )
    );

    const creds = loadCredentials();
    const candidates = authCandidates(creds);

    let lastStatus = null;
    let lastJson = null;
    let lastText = "";

    for (const [user, pass] of candidates) {
      const auth = authHeader(user, pass);
      const { response, json, text } = await emagProductOfferSave(auth, offers);
      lastStatus = response.status;
      lastJson = json;
      lastText = text;

      if (response.status === 401 || response.status === 403) {
        continue;
      }

      if (!json) {
        return res.status(502).json({
          error: "Răspuns invalid de la eMAG",
          status: response.status,
          detail: text.slice(0, 500),
        });
      }

      if (json.isError) {
        return res.status(502).json({
          error: "eMAG a returnat eroare la salvare prețuri",
          messages: json.messages || [],
        });
      }

      return res.json({
        ok: true,
        count: offers.length,
        messages: json.messages || [],
      });
    }

    return res.status(lastStatus || 401).json({
      error: "Autentificare eMAG eșuată (401/403). Verifică credentials și IP whitelist.",
      messages: lastJson?.messages || [],
      detail: lastText.slice(0, 300),
    });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare la sync prețuri" });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const creds = loadCredentials();
    const candidates = authCandidates(creds);

    let lastStatus = null;
    let lastJson = null;
    let lastText = "";
    let usedAuthLabel = "";

    for (const [user, pass] of candidates) {
      const auth = authHeader(user, pass);
      const { response, json, text } = await emagProductOfferRead(auth, page);
      lastStatus = response.status;
      lastJson = json;
      lastText = text;

      if (response.status === 401 || response.status === 403) {
        continue;
      }

      usedAuthLabel = user === creds.USER_EMAIL ? "email" : "api_code";

      if (!json) {
        return res.status(502).json({
          error: "Răspuns invalid de la eMAG",
          status: response.status,
          detail: text.slice(0, 500),
        });
      }

      if (json.isError) {
        return res.status(502).json({
          error: "eMAG a returnat eroare",
          messages: json.messages || [],
        });
      }

      const results = Array.isArray(json.results) ? json.results : [];
      const products = results.map(mapOffer);

      return res.json({
        page,
        itemsPerPage: ITEMS_PER_PAGE,
        count: products.length,
        hasMore: products.length >= ITEMS_PER_PAGE,
        authUsed: usedAuthLabel,
        products,
      });
    }

    return res.status(lastStatus || 401).json({
      error: "Autentificare eMAG eșuată (401/403). Verifică credentials și IP whitelist.",
      messages: lastJson?.messages || [],
      detail: lastText.slice(0, 300),
    });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message || "Eroare server" });
  }
});

app.listen(PORT, () => {
  console.log(`Server pornit: http://localhost:${PORT}`);
});
