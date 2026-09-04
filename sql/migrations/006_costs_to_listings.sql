-- Costuri/comision per oferta: muta din catalog_products pe marketplace_listings.
-- eMAG SoT pastreaza produsul pe catalog; alte_costuri / comision pe listings.

INSERT INTO marketplace_listings (
  channel,
  external_id,
  product_id,
  alte_costuri,
  procentaj_emag,
  commission_value,
  commission_fetched_at,
  created_at,
  updated_at
)
SELECT
  'emag',
  c.emag_offer_id,
  c.id,
  c.alte_costuri,
  c.procentaj_emag,
  c.commission_value,
  c.commission_fetched_at,
  COALESCE(c.created_at, NOW()),
  COALESCE(c.updated_at, NOW())
FROM catalog_products c
WHERE c.emag_offer_id IS NOT NULL
  AND (
    c.alte_costuri IS NOT NULL
    OR c.procentaj_emag IS NOT NULL
    OR c.commission_value IS NOT NULL
    OR c.commission_fetched_at IS NOT NULL
  )
ON CONFLICT (channel, external_id) DO UPDATE SET
  product_id = COALESCE(EXCLUDED.product_id, marketplace_listings.product_id),
  alte_costuri = COALESCE(marketplace_listings.alte_costuri, EXCLUDED.alte_costuri),
  procentaj_emag = COALESCE(marketplace_listings.procentaj_emag, EXCLUDED.procentaj_emag),
  commission_value = COALESCE(marketplace_listings.commission_value, EXCLUDED.commission_value),
  commission_fetched_at = COALESCE(
    marketplace_listings.commission_fetched_at,
    EXCLUDED.commission_fetched_at
  ),
  updated_at = NOW();

ALTER TABLE catalog_products DROP COLUMN IF EXISTS alte_costuri;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS procentaj_emag;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS commission_value;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS commission_fetched_at;
