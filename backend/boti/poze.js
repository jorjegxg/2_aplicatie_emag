/**
 * Verificarea unei poze de produs: se descarcă și se măsoară cu sharp (fără AI).
 *   latime/inaltime, raport, kb, claritate / detaliu (varianța Laplace, vezi sharpness; doar orientativ),
 *   fundal_alb (0..1, din image-white-bg.js), hash (dHash 64 biți, pentru „aceeași poză?”).
 */
const sharp = require("sharp");
const { scoreWhiteBackground } = require("../image-white-bg");

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 20 * 1024 * 1024;

async function download(url) {
  if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("link invalid");
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("poză prea mare");
  return buf;
}

function laplaceVariance({ data, info }) {
  const w = info.width;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < info.height - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = data[i - 1] + data[i + 1] + data[i - w] + data[i + w] - 4 * data[i];
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return Math.round(sum2 / n - mean * mean);
}

/**
 * claritate = varianța Laplace pe poza redusă la 512 px (scade mult la poze mișcate / blurate);
 * detaliu = aceeași măsură pe centrul pozei la rezoluția ei (mică la poze mărite dintr-una mică).
 */
async function sharpness(buf) {
  // Întâi rotirea după EXIF, ca decupajul să folosească dimensiunile reale.
  const grey = await sharp(buf).rotate().greyscale().png({ compressionLevel: 0 }).toBuffer();
  const { width, height } = await sharp(grey).metadata();
  const small = await sharp(grey).resize(512, 512, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const side = Math.min(800, width, height);
  const crop = await sharp(grey)
    .extract({ left: Math.floor((width - side) / 2), top: Math.floor((height - side) / 2), width: side, height: side })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { claritate: laplaceVariance(small), detaliu: laplaceVariance(crop) };
}

async function dhash(buf) {
  const px = await sharp(buf).rotate().greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? "1" : "0";
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

/** Câți biți diferă între două dHash-uri (0 = aceeași poză, peste ~12 = alta). */
function hashDistance(a, b) {
  if (!a || !b) return null;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

async function analyze(url) {
  try {
    const buf = await download(url);
    const meta = await sharp(buf).metadata();
    const [{ claritate, detaliu }, fundal, hash] = await Promise.all([sharpness(buf), scoreWhiteBackground(buf), dhash(buf)]);
    return {
      ok: true,
      latime: meta.width,
      inaltime: meta.height,
      raport: meta.width && meta.height ? Math.round((meta.width / meta.height) * 100) / 100 : null,
      kb: Math.round(buf.length / 1024),
      format: meta.format,
      claritate,
      detaliu,
      fundal_alb: Math.round(fundal * 100) / 100,
      hash,
    };
  } catch (e) {
    return { ok: false, eroare: e.message };
  }
}

/** Poza redusă (max 1000 px, JPEG) ca s-o vadă Claude. */
async function preview(url) {
  const buf = await download(url);
  return sharp(buf).rotate().resize(1000, 1000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
}

module.exports = { analyze, preview, hashDistance };
