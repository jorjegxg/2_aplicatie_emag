const crypto = require("crypto");

const KEY_ENV = "CREDENTIALS_ENCRYPTION_KEY";

function getRawKey() {
  const raw = process.env[KEY_ENV];
  if (raw == null || String(raw).trim() === "") {
    const err = new Error(
      `Lipsește ${KEY_ENV} în .env — setează o cheie secretă lungă.`
    );
    err.code = "ENCRYPTION_KEY_MISSING";
    err.status = 500;
    throw err;
  }
  return String(raw).trim();
}

/** 32-byte AES key derived from env string. */
function getAesKey() {
  return crypto.createHash("sha256").update(getRawKey(), "utf8").digest();
}

/**
 * Encrypt a JSON-serializable object.
 * Format: v1:<iv_b64>:<tag_b64>:<cipher_b64>
 */
function encryptJson(obj) {
  const key = getAesKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj ?? {}), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a string produced by encryptJson.
 */
function decryptJson(encoded) {
  const text = String(encoded || "");
  const parts = text.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Payload criptat invalid (format așteptat v1:iv:tag:data)");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = getAesKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

module.exports = {
  KEY_ENV,
  encryptJson,
  decryptJson,
};
