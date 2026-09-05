const { query, ensureSchema } = require("./pg");
const { encryptJson, decryptJson } = require("./crypto-secrets");

function credentialsMissingError(channel, message) {
  const err = new Error(
    message ||
      `Credentiale lipsă pentru ${channel}. Mergi la Setări (sus-dreapta) și completează-le.`
  );
  err.status = 400;
  err.code = "CREDENTIALS_MISSING";
  err.settingsPath = `/settings.html#${channel}`;
  return err;
}

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

async function readChannelPayload(channel) {
  await ensureSchema();
  const { rows } = await query(
    `SELECT payload_enc FROM marketplace_credentials WHERE channel = $1 LIMIT 1`,
    [channel]
  );
  const enc = rows[0]?.payload_enc;
  if (!enc) return {};
  try {
    const raw = decryptJson(enc);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch (err) {
    const e = new Error(
      `Nu pot decripta credentialele ${channel}: ${err.message}. Verifică CREDENTIALS_ENCRYPTION_KEY.`
    );
    e.status = 500;
    e.code = "CREDENTIALS_DECRYPT_FAILED";
    throw e;
  }
}

async function writeChannelPayload(channel, payload) {
  await ensureSchema();
  const payload_enc = encryptJson(payload);
  await query(
    `INSERT INTO marketplace_credentials (channel, payload_enc, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (channel) DO UPDATE
       SET payload_enc = EXCLUDED.payload_enc,
           updated_at = now()`,
    [channel, payload_enc]
  );
}

async function getEmagCreds() {
  const data = await readChannelPayload("emag");
  return {
    USER_EMAIL: str(data.USER_EMAIL),
    ACCOUNT_PASSWORD: str(data.ACCOUNT_PASSWORD),
    API_CODE: str(data.API_CODE),
  };
}

async function getTrendyolCreds() {
  const data = await readChannelPayload("trendyol");
  return {
    SUPPLIER_ID: str(data.SUPPLIER_ID),
    API_KEY: str(data.API_KEY),
    API_SECRET: str(data.API_SECRET),
  };
}

async function isEmagConfigured() {
  const c = await getEmagCreds();
  return Boolean(c.USER_EMAIL && c.ACCOUNT_PASSWORD);
}

async function isTrendyolConfigured() {
  const c = await getTrendyolCreds();
  return Boolean(c.SUPPLIER_ID && c.API_KEY && c.API_SECRET);
}

/** Pentru auth eMAG — throw CREDENTIALS_MISSING dacă lipsesc. */
async function loadCredentials() {
  const emag = await getEmagCreds();
  if (!emag.USER_EMAIL || !emag.ACCOUNT_PASSWORD) {
    throw credentialsMissingError(
      "emag",
      "Credentiale eMAG lipsă. Mergi la Setări (sus-dreapta) și setează emailul și parola."
    );
  }
  return emag;
}

/**
 * Merge partial updates. Empty password/secret fields keep existing values.
 * @param {{ emag?: object, trendyol?: object }} patch
 */
async function saveCredentialsPatch(patch) {
  if (patch?.emag && typeof patch.emag === "object") {
    const prev = await getEmagCreds();
    const email = str(patch.emag.email ?? patch.emag.USER_EMAIL);
    const password = str(patch.emag.password ?? patch.emag.ACCOUNT_PASSWORD);
    const apiCode = str(patch.emag.apiCode ?? patch.emag.API_CODE);

    const next = {
      USER_EMAIL: email || prev.USER_EMAIL,
      ACCOUNT_PASSWORD: password || prev.ACCOUNT_PASSWORD,
      API_CODE: apiCode || prev.API_CODE,
    };
    await writeChannelPayload("emag", next);
  }

  if (patch?.trendyol && typeof patch.trendyol === "object") {
    const prev = await getTrendyolCreds();
    const supplierId = str(patch.trendyol.supplierId ?? patch.trendyol.SUPPLIER_ID);
    const apiKey = str(patch.trendyol.apiKey ?? patch.trendyol.API_KEY);
    const apiSecret = str(patch.trendyol.apiSecret ?? patch.trendyol.API_SECRET);

    const next = {
      SUPPLIER_ID: supplierId || prev.SUPPLIER_ID,
      API_KEY: apiKey || prev.API_KEY,
      API_SECRET: apiSecret || prev.API_SECRET,
    };
    await writeChannelPayload("trendyol", next);
  }
}

async function publicCredentialsStatus() {
  const emag = await getEmagCreds();
  const trendyol = await getTrendyolCreds();
  return {
    emag: {
      configured: Boolean(emag.USER_EMAIL && emag.ACCOUNT_PASSWORD),
      email: emag.USER_EMAIL || "",
      hasPassword: Boolean(emag.ACCOUNT_PASSWORD),
      hasApiCode: Boolean(emag.API_CODE),
    },
    trendyol: {
      configured: Boolean(trendyol.SUPPLIER_ID && trendyol.API_KEY && trendyol.API_SECRET),
      supplierId: trendyol.SUPPLIER_ID || "",
      hasApiKey: Boolean(trendyol.API_KEY),
      hasApiSecret: Boolean(trendyol.API_SECRET),
    },
  };
}

module.exports = {
  credentialsMissingError,
  getEmagCreds,
  getTrendyolCreds,
  isEmagConfigured,
  isTrendyolConfigured,
  loadCredentials,
  saveCredentialsPatch,
  publicCredentialsStatus,
};
