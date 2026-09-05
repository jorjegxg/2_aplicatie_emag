/**
 * Serviciu poze produs: disc local (uploads/products) + metadate Postgres.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { query, withTransaction, ensureSchema } = require("./pg");

const UPLOAD_ROOT = path.join(__dirname, "uploads");
const PRODUCTS_DIR = path.join(UPLOAD_ROOT, "products");
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function ensureUploadDirs() {
  fs.mkdirSync(PRODUCTS_DIR, { recursive: true });
}

function publicUrl(storedName) {
  return `/uploads/products/${encodeURIComponent(storedName)}`;
}

function mapRow(r) {
  return {
    id: Number(r.id),
    product_id: Number(r.product_id),
    url: publicUrl(r.stored_name),
    original_name: r.original_name || "",
    mime_type: r.mime_type || "",
    byte_size: r.byte_size != null ? Number(r.byte_size) : null,
    sort_order: Number(r.sort_order) || 0,
    created_at:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : r.created_at ?? null,
  };
}

async function productExists(productId) {
  const id = Number(productId);
  if (!Number.isFinite(id) || id <= 0) return false;
  const { rows } = await query(
    `SELECT 1 FROM catalog_products WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows.length > 0;
}

/**
 * @param {number[]} productIds
 * @returns {Promise<Map<number, ReturnType<typeof mapRow>[]>>}
 */
async function listByProductIds(productIds) {
  await ensureSchema();
  const ids = [
    ...new Set(
      (productIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  const map = new Map();
  for (const id of ids) map.set(id, []);
  if (!ids.length) return map;

  const { rows } = await query(
    `SELECT id, product_id, stored_name, original_name, mime_type, byte_size, sort_order, created_at
     FROM product_images
     WHERE product_id = ANY($1::int[])
     ORDER BY product_id ASC, sort_order ASC, id ASC`,
    [ids]
  );
  for (const r of rows) {
    const pid = Number(r.product_id);
    const list = map.get(pid);
    if (list) list.push(mapRow(r));
    else map.set(pid, [mapRow(r)]);
  }
  return map;
}

async function listForProduct(productId) {
  const map = await listByProductIds([productId]);
  return map.get(Number(productId)) || [];
}

function assertAllowedFile(file) {
  const mime = String(file.mimetype || "").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    const err = new Error(`Tip fisier neacceptat: ${mime || "unknown"}`);
    err.status = 400;
    throw err;
  }
  const size = Number(file.size);
  if (Number.isFinite(size) && size > MAX_BYTES) {
    const err = new Error(`Fisier prea mare (max ${MAX_BYTES} bytes)`);
    err.status = 400;
    throw err;
  }
}

function makeStoredName(mime) {
  const ext = EXT_BY_MIME[mime] || "";
  return `${crypto.randomUUID()}${ext}`;
}

/**
 * @param {number|string} productId
 * @param {Express.Multer.File[]} files
 */
async function addImages(productId, files) {
  await ensureSchema();
  ensureUploadDirs();
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) {
    const err = new Error("product_id invalid");
    err.status = 400;
    throw err;
  }
  if (!(await productExists(pid))) {
    const err = new Error("Produs inexistent");
    err.status = 404;
    throw err;
  }

  const list = Array.isArray(files) ? files : [];
  if (!list.length) {
    const err = new Error("Niciun fisier");
    err.status = 400;
    throw err;
  }

  for (const f of list) assertAllowedFile(f);

  const { rows: maxRows } = await query(
    `SELECT COALESCE(MAX(sort_order), -1) AS max_ord FROM product_images WHERE product_id = $1`,
    [pid]
  );
  let nextOrder = Number(maxRows[0]?.max_ord) + 1;
  if (!Number.isFinite(nextOrder) || nextOrder < 0) nextOrder = 0;

  const written = [];
  const inserted = [];

  try {
    for (const file of list) {
      const mime = String(file.mimetype || "").toLowerCase();
      const storedName = makeStoredName(mime);
      const dest = path.join(PRODUCTS_DIR, storedName);
      fs.writeFileSync(dest, file.buffer);
      written.push(dest);

      const { rows } = await query(
        `INSERT INTO product_images
           (product_id, stored_name, original_name, mime_type, byte_size, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, product_id, stored_name, original_name, mime_type, byte_size, sort_order, created_at`,
        [
          pid,
          storedName,
          file.originalname || null,
          mime,
          file.size ?? (file.buffer ? file.buffer.length : null),
          nextOrder++,
        ]
      );
      inserted.push(mapRow(rows[0]));
    }
  } catch (err) {
    for (const p of written) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    throw err;
  }

  return inserted;
}

async function deleteImage(productId, imageId) {
  await ensureSchema();
  const pid = Number(productId);
  const iid = Number(imageId);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(iid) || iid <= 0) {
    const err = new Error("id invalid");
    err.status = 400;
    throw err;
  }

  const { rows } = await query(
    `DELETE FROM product_images
     WHERE id = $1 AND product_id = $2
     RETURNING stored_name`,
    [iid, pid]
  );
  if (!rows.length) {
    const err = new Error("Imagine inexistenta");
    err.status = 404;
    throw err;
  }

  const dest = path.join(PRODUCTS_DIR, rows[0].stored_name);
  try {
    fs.unlinkSync(dest);
  } catch {
    /* fisier deja lipsa — OK */
  }
  return true;
}

async function reorder(productId, imageIds) {
  await ensureSchema();
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) {
    const err = new Error("product_id invalid");
    err.status = 400;
    throw err;
  }
  const ids = (Array.isArray(imageIds) ? imageIds : [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) {
    const err = new Error("image_ids gol");
    err.status = 400;
    throw err;
  }

  await withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT id FROM product_images WHERE product_id = $1`,
      [pid]
    );
    const existingSet = new Set(existing.map((r) => Number(r.id)));
    if (ids.length !== existingSet.size || ids.some((id) => !existingSet.has(id))) {
      const err = new Error("image_ids nu corespund imaginilor produsului");
      err.status = 400;
      throw err;
    }
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        `UPDATE product_images SET sort_order = $1 WHERE id = $2 AND product_id = $3`,
        [i, ids[i], pid]
      );
    }
  });

  return listForProduct(pid);
}

ensureUploadDirs();

module.exports = {
  UPLOAD_ROOT,
  PRODUCTS_DIR,
  MAX_BYTES,
  ALLOWED_MIME,
  ensureUploadDirs,
  listByProductIds,
  listForProduct,
  addImages,
  deleteImage,
  reorder,
  productExists,
};
