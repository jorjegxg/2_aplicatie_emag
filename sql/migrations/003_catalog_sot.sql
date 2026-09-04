-- catalog_products = sursa adevarului pentru oferte eMAG.
-- Copiaza campurile din marketplace_listings (channel=emag) pe catalog.

ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS emag_offer_id TEXT;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS part_number TEXT;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS part_number_key TEXT;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS id_familie INTEGER;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS familie TEXT;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS characteristics TEXT;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12, 4);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS recommended_price NUMERIC(12, 4);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS min_sale_price NUMERIC(12, 4);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS max_sale_price NUMERIC(12, 4);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS general_stock NUMERIC(12, 3);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS estimated_stock NUMERIC(12, 3);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS stock_json JSONB;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS handling_time_json JSONB;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS status INTEGER;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS vat_id INTEGER;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS alte_costuri NUMERIC(12, 4);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS pret_minim_override NUMERIC(12, 4);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS procentaj_emag NUMERIC(8, 4);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS commission_value NUMERIC(12, 4);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS commission_fetched_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_emag_offer
  ON catalog_products (emag_offer_id)
  WHERE emag_offer_id IS NOT NULL;

-- Listings legate de un produs catalog: copiaza pe acel id (un listing per product_id)
UPDATE catalog_products c SET
  emag_offer_id = COALESCE(c.emag_offer_id, l.external_id),
  part_number = COALESCE(c.part_number, l.part_number),
  part_number_key = COALESCE(c.part_number_key, l.part_number_key),
  id_familie = COALESCE(c.id_familie, l.id_familie),
  familie = COALESCE(c.familie, l.familie),
  characteristics = COALESCE(c.characteristics, l.characteristics),
  sale_price = COALESCE(c.sale_price, l.sale_price),
  recommended_price = COALESCE(c.recommended_price, l.recommended_price),
  min_sale_price = COALESCE(c.min_sale_price, l.min_sale_price),
  max_sale_price = COALESCE(c.max_sale_price, l.max_sale_price),
  general_stock = COALESCE(c.general_stock, l.general_stock),
  estimated_stock = COALESCE(c.estimated_stock, l.estimated_stock),
  stock_json = COALESCE(c.stock_json, l.stock_json),
  handling_time_json = COALESCE(c.handling_time_json, l.handling_time_json),
  status = COALESCE(c.status, l.status),
  vat_id = COALESCE(c.vat_id, l.vat_id),
  currency = COALESCE(c.currency, l.currency),
  alte_costuri = COALESCE(c.alte_costuri, l.alte_costuri),
  pret_minim_override = COALESCE(c.pret_minim_override, l.pret_minim_override),
  procentaj_emag = COALESCE(c.procentaj_emag, l.procentaj_emag),
  commission_value = COALESCE(c.commission_value, l.commission_value),
  commission_fetched_at = COALESCE(c.commission_fetched_at, l.commission_fetched_at),
  nume = COALESCE(c.nume, l.name),
  descriere = COALESCE(c.descriere, l.description),
  brand = COALESCE(c.brand, l.brand),
  ean = COALESCE(c.ean, l.ean),
  cod_produs = COALESCE(c.cod_produs, l.part_number),
  updated_at = COALESCE(l.updated_at, c.updated_at, NOW())
FROM (
  SELECT DISTINCT ON (product_id) *
  FROM marketplace_listings
  WHERE channel = 'emag' AND product_id IS NOT NULL
  ORDER BY product_id, updated_at DESC NULLS LAST, id DESC
) l
WHERE l.product_id = c.id
  AND (c.emag_offer_id IS NULL OR c.emag_offer_id = l.external_id);

-- Listings fara product_id: insert catalog daca offer_id nu exista deja
INSERT INTO catalog_products (
  emag_offer_id, cod_produs, nume, descriere, brand, ean,
  part_number, part_number_key, id_familie, familie, characteristics,
  sale_price, recommended_price, min_sale_price, max_sale_price,
  general_stock, estimated_stock, stock_json, handling_time_json,
  status, vat_id, currency,
  alte_costuri, pret_minim_override, procentaj_emag,
  commission_value, commission_fetched_at,
  created_at, updated_at
)
SELECT
  l.external_id,
  l.part_number,
  l.name,
  l.description,
  l.brand,
  l.ean,
  l.part_number,
  l.part_number_key,
  l.id_familie,
  l.familie,
  l.characteristics,
  l.sale_price,
  l.recommended_price,
  l.min_sale_price,
  l.max_sale_price,
  l.general_stock,
  l.estimated_stock,
  l.stock_json,
  l.handling_time_json,
  l.status,
  l.vat_id,
  l.currency,
  l.alte_costuri,
  l.pret_minim_override,
  l.procentaj_emag,
  l.commission_value,
  l.commission_fetched_at,
  COALESCE(l.created_at, NOW()),
  COALESCE(l.updated_at, NOW())
FROM marketplace_listings l
WHERE l.channel = 'emag'
  AND l.product_id IS NULL
  AND l.external_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM catalog_products c WHERE c.emag_offer_id = l.external_id
  );

-- Listings cu product_id dar catalog fara emag_offer_id (conflict pe alt rand):
-- daca offer_id liber, seteaza pe produsul legat
UPDATE catalog_products c SET
  emag_offer_id = l.external_id,
  updated_at = COALESCE(l.updated_at, NOW())
FROM marketplace_listings l
WHERE l.channel = 'emag'
  AND l.product_id = c.id
  AND c.emag_offer_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM catalog_products x
    WHERE x.emag_offer_id = l.external_id AND x.id <> c.id
  );
