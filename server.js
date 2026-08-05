const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const EMAG_API = "https://marketplace-api.emag.ro/api-3";
const ITEMS_PER_PAGE = 100;

const app = express();
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

function mapOffer(offer) {
  const ean = Array.isArray(offer.ean) ? offer.ean.join(", ") : offer.ean || "";
  return {
    id: offer.id,
    name: offer.name || "",
    brand: offer.brand || offer.brand_name || "",
    part_number: offer.part_number || "",
    part_number_key: offer.part_number_key || "",
    sale_price: offer.sale_price ?? null,
    currency: offer.currency || "RON",
    general_stock: offer.general_stock ?? null,
    estimated_stock: offer.estimated_stock ?? null,
    status: offer.status,
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
