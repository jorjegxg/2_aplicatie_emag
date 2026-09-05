/**
 * Serviciu poze produs: S3-compatible (MinIO) + metadate Postgres.
 * URL public rămâne /uploads/products/<stored_name> (proxy din server.js).
 */
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const { query, withTransaction, ensureSchema } = require("./pg");

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

const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://127.0.0.1:9000";
const S3_REGION = process.env.S3_REGION || "us-east-1";
const S3_BUCKET = process.env.S3_BUCKET || "emag-products";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "minioadmin";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "minioadmin";
const S3_FORCE_PATH_STYLE =
  String(process.env.S3_FORCE_PATH_STYLE || "true").toLowerCase() !== "false";
const S3_KEY_PREFIX = "products/";

const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION,
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
  },
  forcePathStyle: S3_FORCE_PATH_STYLE,
});

let bucketReady = false;
let bucketPromise = null;

function objectKey(storedName) {
  const name = String(storedName || "").replace(/^.*[\\/]/, "");
  if (!name || name === "." || name === "..") {
    const err = new Error("stored_name invalid");
    err.status = 400;
    throw err;
  }
  return `${S3_KEY_PREFIX}${name}`;
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
    source_url: r.source_url || null,
    created_at:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : r.created_at ?? null,
  };
}

async function ensureBucket() {
  if (bucketReady) return;
  if (bucketPromise) return bucketPromise;
  bucketPromise = (async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    } catch (err) {
      const status = err?.$metadata?.httpStatusCode;
      const name = String(err?.name || "");
      if (status === 404 || name === "NotFound" || name === "NoSuchBucket") {
        await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
      } else {
        throw err;
      }
    }
    bucketReady = true;
  })().finally(() => {
    bucketPromise = null;
  });
  return bucketPromise;
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

async function putObject(storedName, buffer, mime) {
  await ensureBucket();
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: objectKey(storedName),
      Body: buffer,
      ContentType: mime,
      ContentLength: buffer.length,
    })
  );
}

async function removeObject(storedName) {
  await ensureBucket();
  const key = objectKey(storedName);
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      })
    );
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    const name = String(err?.name || "");
    // S3 DeleteObject e idempotent; NoSuchKey / 404 = deja lipsă
    if (status === 404 || name === "NoSuchKey" || name === "NotFound") return;
    console.error("[product-images] S3 delete failed:", key, err.message);
    throw err;
  }
}

/**
 * Stream obiect S3 pentru proxy HTTP.
 * @returns {Promise<{ body: import("stream").Readable, contentType: string, contentLength: number|null }>}
 */
async function getObjectStream(storedName) {
  await ensureBucket();
  const out = await s3.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: objectKey(storedName),
    })
  );
  return {
    body: out.Body,
    contentType: out.ContentType || "application/octet-stream",
    contentLength:
      out.ContentLength != null ? Number(out.ContentLength) : null,
  };
}

async function objectExists(storedName) {
  await ensureBucket();
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: objectKey(storedName),
      })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number|string} productId
 * @param {Express.Multer.File[]} files
 */
async function addImages(productId, files) {
  await ensureSchema();
  await ensureBucket();
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
      const buffer = file.buffer;
      await putObject(storedName, buffer, mime);
      written.push(storedName);

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
          file.size ?? (buffer ? buffer.length : null),
          nextOrder++,
        ]
      );
      inserted.push(mapRow(rows[0]));
    }
  } catch (err) {
    for (const name of written) {
      await removeObject(name);
    }
    throw err;
  }

  return inserted;
}

async function deleteImage(productId, imageId) {
  await ensureSchema();
  await ensureBucket();
  const pid = Number(productId);
  const iid = Number(imageId);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(iid) || iid <= 0) {
    const err = new Error("id invalid");
    err.status = 400;
    throw err;
  }

  // Citește key înainte — șterge S3 întâi, apoi DB (evită orfani pe MinIO).
  const { rows: found } = await query(
    `SELECT stored_name FROM product_images WHERE id = $1 AND product_id = $2`,
    [iid, pid]
  );
  if (!found.length) {
    const err = new Error("Imagine inexistenta");
    err.status = 404;
    throw err;
  }

  await removeObject(found[0].stored_name);

  const { rows } = await query(
    `DELETE FROM product_images
     WHERE id = $1 AND product_id = $2
     RETURNING id`,
    [iid, pid]
  );
  if (!rows.length) {
    const err = new Error("Imagine inexistenta");
    err.status = 404;
    throw err;
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

/* ---------------- import poze din URL extern (eMAG) ---------------- */

// Pozele de pe CDN-ul eMAG pot depasi limita de upload manual (5 MB).
const MAX_REMOTE_BYTES = 15 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 3;

function mimeFromUrl(url) {
  const clean = String(url || "").split("?")[0].toLowerCase();
  if (/\.jpe?g$/.test(clean)) return "image/jpeg";
  if (/\.png$/.test(clean)) return "image/png";
  if (/\.webp$/.test(clean)) return "image/webp";
  if (/\.gif$/.test(clean)) return "image/gif";
  return "";
}

/**
 * Descarca o imagine dintr-un URL public.
 * @returns {Promise<{ buffer: Buffer, mime: string }>}
 */
function downloadImage(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      reject(new Error(`URL invalid: ${url}`));
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reject(new Error(`Protocol neacceptat: ${parsed.protocol}`));
      return;
    }

    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      parsed,
      { method: "GET", headers: { "User-Agent": "aplicatie-emag/1.0" } },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("Prea multe redirect-uri"));
            return;
          }
          const next = new URL(res.headers.location, parsed).toString();
          downloadImage(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }

        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > MAX_REMOTE_BYTES) {
          res.destroy();
          reject(new Error(`Imagine prea mare (${declared} bytes)`));
          return;
        }

        const headerMime = String(res.headers["content-type"] || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const mime = ALLOWED_MIME.has(headerMime)
          ? headerMime
          : mimeFromUrl(parsed.pathname);
        if (!ALLOWED_MIME.has(mime)) {
          res.destroy();
          reject(new Error(`Tip continut neacceptat: ${headerMime || "necunoscut"}`));
          return;
        }

        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_REMOTE_BYTES) {
            res.destroy(new Error(`Imagine prea mare (> ${MAX_REMOTE_BYTES} bytes)`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ buffer: Buffer.concat(chunks), mime }));
        res.on("error", reject);
      }
    );

    req.setTimeout(REMOTE_TIMEOUT_MS, () => {
      req.destroy(new Error("timeout descarcare imagine"));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Sterge pozele provenite din sursa externa (source_url NOT NULL) si le descarca
 * din nou de la URL-urile date. Uploadurile manuale (source_url NULL) raman intacte.
 * @param {number|string} productId
 * @param {string[]} urls
 * @returns {Promise<{ deleted: number, added: object[], failed: {url: string, error: string}[] }>}
 */
async function replaceRemoteImages(productId, urls) {
  await ensureSchema();
  await ensureBucket();
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) {
    const err = new Error("product_id invalid");
    err.status = 400;
    throw err;
  }

  const list = [
    ...new Set(
      (Array.isArray(urls) ? urls : [])
        .map((u) => String(u || "").trim())
        .filter(Boolean)
    ),
  ];

  // 1. sterge pozele externe existente (S3 intai, apoi DB — ca in deleteImage)
  const { rows: old } = await query(
    `SELECT id, stored_name FROM product_images
     WHERE product_id = $1 AND source_url IS NOT NULL`,
    [pid]
  );
  for (const row of old) {
    await removeObject(row.stored_name);
    await query(`DELETE FROM product_images WHERE id = $1`, [row.id]);
  }

  // 2. descarca si urca pozele noi, dupa pozele manuale ramase
  const { rows: maxRows } = await query(
    `SELECT COALESCE(MAX(sort_order), -1) AS max_ord FROM product_images WHERE product_id = $1`,
    [pid]
  );
  let nextOrder = Number(maxRows[0]?.max_ord) + 1;
  if (!Number.isFinite(nextOrder) || nextOrder < 0) nextOrder = 0;

  const added = [];
  const failed = [];

  for (const url of list) {
    let storedName = null;
    try {
      const { buffer, mime } = await downloadImage(url);
      storedName = makeStoredName(mime);
      await putObject(storedName, buffer, mime);
      const { rows } = await query(
        `INSERT INTO product_images
           (product_id, stored_name, original_name, mime_type, byte_size, sort_order, source_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, product_id, stored_name, original_name, mime_type, byte_size, sort_order, source_url, created_at`,
        [
          pid,
          storedName,
          decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || null,
          mime,
          buffer.length,
          nextOrder,
          url,
        ]
      );
      added.push(mapRow(rows[0]));
      nextOrder += 1;
    } catch (err) {
      // obiect scris pe S3 dar fara rand in DB -> curata, nu lasa orfani
      if (storedName) {
        try {
          await removeObject(storedName);
        } catch {
          /* ignore */
        }
      }
      failed.push({ url, error: err.message });
    }
  }

  return { deleted: old.length, added, failed };
}

module.exports = {
  MAX_BYTES,
  ALLOWED_MIME,
  S3_BUCKET,
  S3_ENDPOINT,
  ensureBucket,
  listByProductIds,
  listForProduct,
  addImages,
  deleteImage,
  reorder,
  productExists,
  getObjectStream,
  objectExists,
  objectKey,
  downloadImage,
  replaceRemoteImages,
  MAX_REMOTE_BYTES,
};
