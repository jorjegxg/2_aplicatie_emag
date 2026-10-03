#!/usr/bin/env bash
# Citește din baza de date a aplicației tot ce trebuie pentru o listare eMAG.
#
# Utilizare:
#   produs_din_db.sh <id | cod_produs | PNK | EAN | emag_offer_id | text din nume>
#   produs_din_db.sh "perna lombara"
#
# Conexiune: DATABASE_URL (dacă e setat și există psql local), altfel
# docker exec în containerul ${EMAG_DB_CONTAINER:-emag-db}.
set -euo pipefail

if [ $# -lt 1 ] || [ -z "$1" ]; then
  sed -n '2,9p' "$0"
  exit 1
fi

run_sql() {
  if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null; then
    psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v q="$1" -P pager=off
  else
    docker exec -i -e Q="$1" "${EMAG_DB_CONTAINER:-emag-db}" \
      sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -v ON_ERROR_STOP=1 -v q="$Q" -P pager=off'
  fi
}

run_sql "$1" <<'SQL'
\pset footer off
-- Potrivirile exacte (id, cod, PNK, EAN, offer) au prioritate; altfel caută în nume/cod.
CREATE TEMP TABLE exacte AS
  SELECT id FROM catalog_products
  WHERE id::text = :'q' OR cod_produs ILIKE :'q' OR part_number_key = :'q'
     OR ean = :'q' OR emag_offer_id = :'q';
CREATE TEMP TABLE gasite AS
  SELECT id FROM exacte
  UNION
  SELECT id FROM catalog_products
  WHERE NOT EXISTS (SELECT 1 FROM exacte)
    AND (nume ILIKE '%' || :'q' || '%' OR cod_produs ILIKE '%' || :'q' || '%');
CREATE TEMP TABLE detalii AS SELECT id FROM gasite ORDER BY id LIMIT 3;

\echo '== Produse găsite =='
SELECT c.id, c.cod_produs, f.name AS familie, c.nume
FROM catalog_products c
LEFT JOIN product_families f ON f.id = c.id_familie
WHERE c.id IN (SELECT id FROM gasite)
ORDER BY c.id LIMIT 30;
SELECT CASE WHEN count(*) = 0 THEN 'Niciun produs găsit.'
            WHEN count(*) > 3 THEN count(*) || ' produse găsite; detaliile de mai jos sunt doar pentru primele 3 (caută mai precis după id sau cod_produs).'
       END AS nota
FROM gasite \gset
\if :{?nota}
\echo :nota
\endif
SELECT NOT EXISTS (SELECT 1 FROM gasite) AS gol \gset
\if :gol
\q
\endif

\echo
\echo '== Detalii =='
\x on
SELECT c.id, c.cod_produs, c.nume AS titlu_actual, length(c.nume) AS titlu_caractere,
       c.brand, f.name AS familie, c.part_number_key AS pnk, c.emag_offer_id, c.ean,
       c.lungime || ' x ' || c.latime || ' x ' || c.inaltime || ' cm' AS dimensiuni_l_x_l_x_i,
       c.greutate AS greutate_kg, c.nr_bucati,
       c.link_cumparare, c.link_ali, c.link_amz,
       c.descriere AS descriere_actuala
FROM catalog_products c
LEFT JOIN product_families f ON f.id = c.id_familie
WHERE c.id IN (SELECT id FROM detalii)
ORDER BY c.id;
\x off

\echo '== Variante din aceeași familie (culori / mărimi) =='
SELECT c.id, c.cod_produs, c.lungime || 'x' || c.latime || 'x' || c.inaltime AS dim_cm, c.greutate AS kg, c.nume
FROM catalog_products c
WHERE c.id_familie IN (SELECT id_familie FROM catalog_products WHERE id IN (SELECT id FROM detalii))
ORDER BY c.id_familie, c.id;

\echo '== Caracteristici eMAG salvate (id caracteristică: valoare) =='
SELECT m.product_id AS id, m.channel, m.characteristics
FROM marketplace_listings m
WHERE m.product_id IN (SELECT id FROM detalii)
ORDER BY m.product_id, m.channel;

\echo '== Poze încărcate (vizibile în aplicație, pagina produsului) =='
SELECT i.product_id AS id, i.platform, count(*) AS nr_poze,
       string_agg(coalesce(i.original_name, i.stored_name), ', ' ORDER BY i.sort_order) AS ordine
FROM product_images i
WHERE i.product_id IN (SELECT id FROM detalii)
GROUP BY i.product_id, i.platform
ORDER BY i.product_id, i.platform;

\echo '== Ce lipsește =='
SELECT c.id, c.cod_produs,
       coalesce(nullif(concat_ws('; ',
         CASE WHEN c.lungime IS NULL OR c.latime IS NULL OR c.inaltime IS NULL THEN 'dimensiuni lipsă — cere-le, nu le inventa' END,
         CASE WHEN c.greutate IS NULL THEN 'greutate lipsă' END,
         CASE WHEN coalesce(c.link_cumparare, c.link_ali, c.link_amz) IS NULL THEN 'niciun link de furnizor — cere-l utilizatorului' END,
         CASE WHEN coalesce(c.descriere, '') = '' THEN 'fără descriere' END,
         CASE WHEN c.brand IS NULL OR upper(c.brand) IN ('OEM', 'NO BRAND', 'GENERIC', 'FARA BRAND') THEN 'fără brand propriu — nu pune brandul în titlu' END,
         CASE WHEN NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = c.id) THEN 'fără poze' END,
         CASE WHEN NOT EXISTS (SELECT 1 FROM marketplace_listings m WHERE m.product_id = c.id AND coalesce(m.characteristics, '') <> '') THEN 'fără caracteristici salvate' END
       ), ''), 'nimic') AS probleme
FROM catalog_products c
WHERE c.id IN (SELECT id FROM detalii)
ORDER BY c.id;

\echo '== Familii cu dimensiuni diferite între variante (verifică!) =='
SELECT f.name AS familie, string_agg(DISTINCT c.lungime || 'x' || c.latime || 'x' || c.inaltime, ' | ') AS dimensiuni
FROM catalog_products c
JOIN product_families f ON f.id = c.id_familie
WHERE c.id_familie IN (SELECT id_familie FROM catalog_products WHERE id IN (SELECT id FROM detalii))
GROUP BY f.name
HAVING count(DISTINCT concat_ws('x', c.lungime, c.latime, c.inaltime)) > 1;
SQL
