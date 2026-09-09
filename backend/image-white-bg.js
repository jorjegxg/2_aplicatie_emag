/**
 * Scor packshot: produs pe fundal alb.
 * Margini albe + conținut non-alb în centru = scor mai mare.
 */
const sharp = require("sharp");

const SIZE = 64;
const WHITE_THRESHOLD = 240;
const BORDER = 2;

/**
 * @param {Buffer} buffer
 * @returns {Promise<number>} scor 0..1
 */
async function scoreWhiteBackground(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 0;

  let data;
  let info;
  try {
    const result = await sharp(buffer)
      .rotate()
      .resize(SIZE, SIZE, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = result.data;
    info = result.info;
  } catch {
    return 0;
  }

  const width = info.width || SIZE;
  const height = info.height || SIZE;
  const channels = info.channels || 3;
  if (channels < 3) return 0;

  let borderTotal = 0;
  let borderWhite = 0;
  let centerTotal = 0;
  let centerContent = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const isWhite =
        r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD;
      const onBorder =
        x < BORDER ||
        y < BORDER ||
        x >= width - BORDER ||
        y >= height - BORDER;

      if (onBorder) {
        borderTotal += 1;
        if (isWhite) borderWhite += 1;
      } else {
        centerTotal += 1;
        if (!isWhite) centerContent += 1;
      }
    }
  }

  const borderScore = borderTotal > 0 ? borderWhite / borderTotal : 0;
  const centerScore = centerTotal > 0 ? centerContent / centerTotal : 0;
  return borderScore * (0.4 + 0.6 * centerScore);
}

/**
 * Sortează iteme după scor descrescător; la egalitate păstrează ordinea inițială.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => Promise<Buffer|null>|Buffer|null} getBuffer
 * @returns {Promise<T[]>}
 */
async function sortByWhiteBackground(items, getBuffer) {
  const list = Array.isArray(items) ? items : [];
  const scored = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    let score = 0;
    try {
      const buf = await getBuffer(item);
      if (buf) score = await scoreWhiteBackground(buf);
    } catch {
      score = 0;
    }
    scored.push({ item, score, idx: i });
  }
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((s) => s.item);
}

module.exports = {
  scoreWhiteBackground,
  sortByWhiteBackground,
};
