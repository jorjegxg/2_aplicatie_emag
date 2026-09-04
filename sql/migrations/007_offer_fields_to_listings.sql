-- Campuri oferta eMAG: muta din catalog_products pe marketplace_listings.
-- Catalog pastreaza produsul; characteristics / stoc detaliat / status / vat pe listings.

INSERT INTO marketplace_listings (
  channel,
  external_id,
  product_id,
  characteristics,
  estimated_stock,
  stock_json,
  handling_time_json,
  status,
  vat_id,
  created_at,
  updated_at
)
SELECT
  'emag',
  c.emag_offer_id,
  c.id,
  c.characteristics,
  c.estimated_stock,
  c.stock_json,
  c.handling_time_json,
  c.status,
  c.vat_id,
  COALESCE(c.created_at, NOW()),
  COALESCE(c.updated_at, NOW())
FROM catalog_products c
WHERE c.emag_offer_id IS NOT NULL
  AND (
    c.characteristics IS NOT NULL
    OR c.estimated_stock IS NOT NULL
    OR c.stock_json IS NOT NULL
    OR c.handling_time_json IS NOT NULL
    OR c.status IS NOT NULL
    OR c.vat_id IS NOT NULL
  )
ON CONFLICT (channel, external_id) DO UPDATE SET
  product_id = COALESCE(EXCLUDED.product_id, marketplace_listings.product_id),
  characteristics = COALESCE(marketplace_listings.characteristics, EXCLUDED.characteristics),
  estimated_stock = COALESCE(marketplace_listings.estimated_stock, EXCLUDED.estimated_stock),
  stock_json = COALESCE(marketplace_listings.stock_json, EXCLUDED.stock_json),
  handling_time_json = COALESCE(
    marketplace_listings.handling_time_json,
    EXCLUDED.handling_time_json
  ),
  status = COALESCE(marketplace_listings.status, EXCLUDED.status),
  vat_id = COALESCE(marketplace_listings.vat_id, EXCLUDED.vat_id),
  updated_at = NOW();

ALTER TABLE catalog_products DROP COLUMN IF EXISTS characteristics;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS estimated_stock;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS stock_json;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS handling_time_json;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS status;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS vat_id;
