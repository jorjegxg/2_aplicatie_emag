const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

function loadEnvFile() {
  // .env sta in radacina repo-ului (un nivel peste backend/); in container lipseste
  // complet si variabilele vin din docker compose.
  const candidates = [
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", ".env"),
  ];
  const envPath = candidates.find((p) => fs.existsSync(p));
  if (!envPath) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = val;
  }
}

loadEnvFile();

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://emag:emag@127.0.0.1:5432/emag";

const SCHEMA_VERSION = 6;

const pool = new Pool({ connectionString: DATABASE_URL });

let schemaReady = false;
let schemaPromise = null;

async function query(text, params = []) {
  return pool.query(text, params);
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withTransaction(fn) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  });
}

async function getSchemaVersion(client) {
  const { rows } = await client.query(
    `SELECT value FROM app_meta WHERE key = 'schema_version' LIMIT 1`
  );
  const n = Number(rows[0]?.value);
  return Number.isFinite(n) ? n : 0;
}

async function setSchemaVersion(client, version) {
  await client.query(
    `INSERT INTO app_meta (key, value) VALUES ('schema_version', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(version)]
  );
}

async function runMigrations(client, { fresh = false } = {}) {
  let version = await getSchemaVersion(client);
  const migrationsDir = path.join(__dirname, "sql", "migrations");
  if (!fs.existsSync(migrationsDir)) {
    if (version < SCHEMA_VERSION) await setSchemaVersion(client, SCHEMA_VERSION);
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/i.test(f))
    .sort();

  // Pe o baza noua, schema.sql a creat deja forma finala. Migratiile vechi
  // presupun schema veche (ex. 005 sterge coloana `familie`, care nu mai exista)
  // si ar crapa - le sarim si marcam versiunea la ultima migratie.
  if (fresh) {
    const latest = files.reduce((max, f) => {
      const n = Number(f.split("_")[0]);
      return Number.isFinite(n) && n > max ? n : max;
    }, SCHEMA_VERSION);
    await setSchemaVersion(client, latest);
    return;
  }

  for (const file of files) {
    const fileVersion = Number(file.split("_")[0]);
    if (!Number.isFinite(fileVersion) || fileVersion <= version) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await client.query(sql);
    await setSchemaVersion(client, fileVersion);
    version = fileVersion;
  }

  if (version < SCHEMA_VERSION) {
    await setSchemaVersion(client, SCHEMA_VERSION);
  }
}

async function ensureSchema() {
  if (schemaReady) return;
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const schemaPath = path.join(__dirname, "sql", "schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8");
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT to_regclass('public.app_meta') IS NULL AS fresh`
      );
      const fresh = rows[0]?.fresh === true;
      await client.query(sql);
      await runMigrations(client, { fresh });
    });
    schemaReady = true;
  })();
  try {
    await schemaPromise;
  } catch (err) {
    schemaPromise = null;
    schemaReady = false;
    throw err;
  }
}

async function endPool() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  withClient,
  withTransaction,
  ensureSchema,
  endPool,
  DATABASE_URL,
  SCHEMA_VERSION,
};
