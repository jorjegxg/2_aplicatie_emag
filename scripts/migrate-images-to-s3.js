/**
 * Migrează pozele din uploads/products (disc) în MinIO/S3.
 * Rulează după: docker compose up -d minio
 *   node scripts/migrate-images-to-s3.js
 */
const fs = require("fs");
const path = require("path");
const {
  ensureBucket,
  objectExists,
  objectKey,
  S3_BUCKET,
} = require("../product-images");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { query, ensureSchema } = require("../pg");

const PRODUCTS_DIR = path.join(__dirname, "..", "uploads", "products");

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT || "http://127.0.0.1:9000",
  region: process.env.S3_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || "minioadmin",
    secretAccessKey: process.env.S3_SECRET_KEY || "minioadmin",
  },
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || "true").toLowerCase() !== "false",
});

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function main() {
  await ensureSchema();
  await ensureBucket();

  const { rows } = await query(
    `SELECT stored_name, mime_type FROM product_images ORDER BY id`
  );

  let uploaded = 0;
  let skipped = 0;
  let missing = 0;

  for (const row of rows) {
    const name = row.stored_name;
    if (await objectExists(name)) {
      skipped++;
      continue;
    }
    const local = path.join(PRODUCTS_DIR, name);
    if (!fs.existsSync(local)) {
      console.warn(`lipsă local: ${name}`);
      missing++;
      continue;
    }
    const buf = fs.readFileSync(local);
    const ext = path.extname(name).toLowerCase();
    const mime = row.mime_type || MIME_BY_EXT[ext] || "application/octet-stream";
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: objectKey(name),
        Body: buf,
        ContentType: mime,
        ContentLength: buf.length,
      })
    );
    uploaded++;
    console.log(`OK ${name}`);
  }

  console.log(
    `Gata. uploaded=${uploaded} skipped=${skipped} missing=${missing} total_db=${rows.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
