/**
 * Varianta Trendyol a unei poze din galerie: 1200x1800 (2:3), cum cere Trendyol RO.
 * Poza (de obicei 2000x2000) se micsoreaza si se pune centrat; benzile de sus/jos
 * iau culoarea marginii pozei daca marginea e uniforma (fundal alb sau banda de
 * titlu), altfel alb. Rezultatul se pastreaza in bucket, in folderul trendyol/, sub
 * un nume derivat, deci se genereaza o singura data per poza.
 */
const sharp = require("sharp");
const { getObjectBuffer, putObject, objectExists, absoluteUrl } = require("./product-images");

const WIDTH = 1200;
const HEIGHT = 1800;
const WHITE = { r: 255, g: 255, b: 255 };
/** Deviatia maxima pe canal ca marginea sa conteze drept culoare uniforma. */
const UNIFORM_STDEV = 6;
/** Se schimba cand se schimba randarea, ca variantele vechi sa nu fie refolosite. */
const VARIANT_PREFIX = "v1-";
/** Folderul din bucket al variantelor Trendyol, separat de pozele din galerie. */
const FOLDER = "trendyol";

/** @param {string} storedName */
function trendyolStoredName(storedName) {
  const base = String(storedName || "").replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return `${VARIANT_PREFIX}${base}.jpg`;
}

/** Culoarea unei benzi de 2px din poza, daca e uniforma; altfel alb. */
async function edgeColor(img, info, top) {
  // stats() ignora extract() din acelasi pipeline, deci banda trece printr-un buffer.
  const raw = await sharp(img)
    .extract({ left: 0, top, width: info.width, height: 2 })
    .png()
    .toBuffer();
  const [r, g, b] = (await sharp(raw).stats()).channels;
  if ([r, g, b].some((c) => !c || c.stdev > UNIFORM_STDEV)) return WHITE;
  return { r: Math.round(r.mean), g: Math.round(g.mean), b: Math.round(b.mean) };
}

/**
 * @param {Buffer} buffer poza originala
 * @returns {Promise<Buffer>} JPEG 1200x1800
 */
async function renderTrendyolVariant(buffer) {
  const { data: img, info } = await sharp(buffer)
    .rotate()
    .flatten({ background: WHITE })
    .resize(WIDTH, HEIGHT, { fit: "inside", withoutEnlargement: false })
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });

  const padX = WIDTH - info.width;
  const padY = HEIGHT - info.height;
  const topColor = padY > 0 ? await edgeColor(img, info, 0) : WHITE;
  const bottomColor = padY > 0 ? await edgeColor(img, info, info.height - 2) : WHITE;
  const top = Math.floor(padY / 2);
  const left = Math.floor(padX / 2);

  // Benzile sus/jos pot avea culori diferite, deci compunem pe o panza cu doua jumatati.
  const half = Math.floor(HEIGHT / 2);
  const band = (color, height) =>
    sharp({ create: { width: WIDTH, height, channels: 3, background: color } }).png().toBuffer();

  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: WHITE } })
    .composite([
      { input: await band(topColor, half), top: 0, left: 0 },
      { input: await band(bottomColor, HEIGHT - half), top: half, left: 0 },
      { input: img, top, left },
    ])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

/**
 * URL public al variantei Trendyol; o genereaza si o urca daca nu exista deja.
 * @param {string} storedName poza din galerie (product_images.stored_name)
 */
async function trendyolImageUrl(storedName) {
  const derived = trendyolStoredName(storedName);
  if (!(await objectExists(derived, FOLDER))) {
    const out = await renderTrendyolVariant(await getObjectBuffer(storedName));
    await putObject(derived, out, "image/jpeg", FOLDER);
  }
  return absoluteUrl(derived, FOLDER);
}

module.exports = {
  WIDTH,
  HEIGHT,
  trendyolStoredName,
  renderTrendyolVariant,
  trendyolImageUrl,
};
