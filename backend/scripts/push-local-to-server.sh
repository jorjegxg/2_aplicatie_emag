#!/usr/bin/env bash
# Copiaza catalogul + pozele de pe masina locala pe server (VPS).
#
# Se ruleaza PE LAPTOP, nu pe server: sursa (Postgres 5433 + MinIO 9000) e locala,
# destinatia e stack-ul Docker de pe VPS (Postgres 5432 + MinIO 9000 publicate).
#
# Ce face:
#   1. verifica conexiunea la ambele baze;
#   2. se asigura ca pe server exista coloana product_images.source_url (migrarea 011);
#   3. copiaza product_families (upsert dupa id, ca id_familie sa ramana valid);
#   4. sterge catalog_products + product_images pe server si le copiaza 1:1 din local,
#      pastrand id-urile; marketplace_listings ramane, doar product_id devine NULL
#      (ON DELETE SET NULL) si e relegat dupa external_id = emag_offer_id;
#   5. `mc mirror` bucket-ul de poze local -> server (adauga/actualizeaza, nu sterge).
#
# Exemplu:
#   DST_DB='postgres://emag:PAROLA@89.44.137.240:5432/emag' \
#   DST_S3_ACCESS_KEY=... DST_S3_SECRET_KEY=... \
#   SRC_S3_ACCESS_KEY=... SRC_S3_SECRET_KEY=... \
#   bash backend/scripts/push-local-to-server.sh

set -euo pipefail

SRC_DB="${SRC_DB:-postgres://emag:emag@127.0.0.1:5433/emag}"
DST_DB="${DST_DB:?Seteaza DST_DB=postgres://emag:PAROLA@HOST:5432/emag}"

SRC_S3_ENDPOINT="${SRC_S3_ENDPOINT:-http://127.0.0.1:9000}"
SRC_S3_ACCESS_KEY="${SRC_S3_ACCESS_KEY:-minioadmin}"
SRC_S3_SECRET_KEY="${SRC_S3_SECRET_KEY:-minioadmin}"
DST_S3_ENDPOINT="${DST_S3_ENDPOINT:?Seteaza DST_S3_ENDPOINT=http://HOST:9000}"
DST_S3_ACCESS_KEY="${DST_S3_ACCESS_KEY:?Seteaza DST_S3_ACCESS_KEY}"
DST_S3_SECRET_KEY="${DST_S3_SECRET_KEY:?Seteaza DST_S3_SECRET_KEY}"
S3_BUCKET="${S3_BUCKET:-emag-products}"
S3_BUCKET_DST="${S3_BUCKET_DST:-$S3_BUCKET}"

SKIP_DB="${SKIP_DB:-0}"
SYNC_FAMILIES="${SYNC_FAMILIES:-1}"
SKIP_IMAGES="${SKIP_IMAGES:-0}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

q() { psql "$1" -X -A -t -v ON_ERROR_STOP=1 -c "$2"; }

# Coloanele comune celor doua baze, in ordinea din sursa: daca schemele difera
# (ex. server fara o coloana adaugata local), copiem doar ce exista in ambele.
common_cols() {
  local table="$1"
  local src dst
  src="$(q "$SRC_DB" "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='$table' ORDER BY ordinal_position")"
  dst="$(q "$DST_DB" "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='$table'")"
  local out=""
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    if grep -qxF "$c" <<<"$dst"; then out="${out:+$out, }$c"; fi
  done <<<"$src"
  echo "$out"
}

if [ "$SKIP_DB" != "1" ]; then
  command -v psql >/dev/null || { echo "Lipseste psql (apt install postgresql-client)"; exit 1; }
  echo "==> Verific conexiunile"
  echo "    local:  $(q "$SRC_DB" "SELECT count(*) FROM catalog_products") produse in catalog_products"
  echo "    server: $(q "$DST_DB" "SELECT count(*) FROM catalog_products") produse (vor fi inlocuite)"

  echo "==> Aliniez schema pe server (migrarea 011: product_images.source_url)"
  psql "$DST_DB" -X -q -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS source_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS product_images_source_uidx
  ON product_images (product_id, source_url)
  WHERE source_url IS NOT NULL;
SQL

  CAT_COLS="$(common_cols catalog_products)"
  IMG_COLS="$(common_cols product_images)"
  [ -n "$CAT_COLS" ] || { echo "catalog_products: nicio coloana comuna"; exit 1; }
  echo "==> catalog_products: $CAT_COLS"
  echo "==> product_images:   ${IMG_COLS:-<tabel absent local>}"

  echo "==> Export din baza locala"
  psql "$SRC_DB" -X -q -v ON_ERROR_STOP=1 \
    -c "\\copy (SELECT $CAT_COLS FROM catalog_products ORDER BY id) TO '$WORK/catalog_products.csv' WITH (FORMAT csv)"
  if [ -n "$IMG_COLS" ]; then
    psql "$SRC_DB" -X -q -v ON_ERROR_STOP=1 \
      -c "\\copy (SELECT $IMG_COLS FROM product_images ORDER BY id) TO '$WORK/product_images.csv' WITH (FORMAT csv)"
  else
    : > "$WORK/product_images.csv"
  fi
  if [ "$SYNC_FAMILIES" = "1" ]; then
    psql "$SRC_DB" -X -q -v ON_ERROR_STOP=1 \
      -c "\\copy (SELECT id, name FROM product_families ORDER BY id) TO '$WORK/product_families.csv' WITH (FORMAT csv)"
  fi
  wc -l "$WORK"/*.csv

  echo "==> Import pe server (o singura tranzactie)"
  {
    if [ "$SYNC_FAMILIES" = "1" ]; then
      # Upsert dupa id: familiile nu au identity, id-ul vine din eMAG.
      echo "CREATE TEMP TABLE fam_in (id INTEGER, name TEXT) ON COMMIT DROP;"
      echo "\\copy fam_in (id, name) FROM '$WORK/product_families.csv' WITH (FORMAT csv)"
      echo "INSERT INTO product_families (id, name) SELECT id, name FROM fam_in ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;"
    fi
    # DELETE, nu TRUNCATE CASCADE: pastreaza randurile din marketplace_listings
    # (product_id -> NULL) in loc sa le stearga; pozele pica prin ON DELETE CASCADE.
    echo "DELETE FROM product_images;"
    echo "DELETE FROM catalog_products;"
    echo "\\copy catalog_products ($CAT_COLS) FROM '$WORK/catalog_products.csv' WITH (FORMAT csv)"
    if [ -n "$IMG_COLS" ]; then
      echo "\\copy product_images ($IMG_COLS) FROM '$WORK/product_images.csv' WITH (FORMAT csv)"
    fi
    # Releaga ofertele existente de produsele nou importate (vezi marketplace-db.js).
    echo "UPDATE marketplace_listings ml SET product_id = c.id FROM catalog_products c WHERE ml.product_id IS NULL AND ml.channel = 'emag' AND ml.external_id = c.emag_offer_id;"
    # Identity-urile repornesc de la max(id), altfel insert-urile urmatoare crapa.
    echo "SELECT setval(pg_get_serial_sequence('catalog_products','id'), COALESCE((SELECT max(id) FROM catalog_products), 1));"
    echo "SELECT setval(pg_get_serial_sequence('product_images','id'), COALESCE((SELECT max(id) FROM product_images), 1));"
  } > "$WORK/import.sql"
  psql "$DST_DB" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$WORK/import.sql"

  echo "    server dupa import: $(q "$DST_DB" "SELECT count(*) FROM catalog_products") produse, $(q "$DST_DB" "SELECT count(*) FROM product_images") poze, $(q "$DST_DB" "SELECT count(*) FROM marketplace_listings WHERE product_id IS NOT NULL") oferte legate"
fi

if [ "$SKIP_IMAGES" != "1" ]; then
  echo "==> Copiez pozele din MinIO ($S3_BUCKET)"
  MCCFG="$WORK/mc"
  mkdir -p "$MCCFG"
  if command -v mc >/dev/null; then
    MC=(mc --config-dir "$MCCFG")
  else
    echo "    mc lipseste local, folosesc containerul minio/mc"
    MC=(docker run --rm --network host -v "$MCCFG:/mc" minio/mc:latest --config-dir /mc)
  fi
  # `alias set` in loc de MC_HOST_*: cheile pot contine caractere care ar trebui
  # url-encodate intr-un URL.
  "${MC[@]}" alias set src "$SRC_S3_ENDPOINT" "$SRC_S3_ACCESS_KEY" "$SRC_S3_SECRET_KEY" >/dev/null
  "${MC[@]}" alias set dst "$DST_S3_ENDPOINT" "$DST_S3_ACCESS_KEY" "$DST_S3_SECRET_KEY" >/dev/null
  "${MC[@]}" mb -p "dst/$S3_BUCKET_DST" >/dev/null
  "${MC[@]}" mirror --overwrite "src/$S3_BUCKET" "dst/$S3_BUCKET_DST"
  echo "    obiecte pe server: $("${MC[@]}" ls --recursive "dst/$S3_BUCKET_DST" | wc -l)"
fi

echo "==> Gata."
