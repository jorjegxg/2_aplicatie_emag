-- pret_minim_override: muta din catalog_products pe marketplace_listings (eMAG).

INSERT INTO marketplace_listings (
  channel,
  external_id,
  product_id,
  pret_minim_override,
  created_at,
  updated_at
)
SELECT
  'emag',
  c.emag_offer_id,
  c.id,
  c.pret_minim_override,
  COALESCE(c.created_at, NOW()),
  COALESCE(c.updated_at, NOW())
FROM catalog_products c
WHERE c.emag_offer_id IS NOT NULL
  AND c.pret_minim_override IS NOT NULL
ON CONFLICT (channel, external_id) DO UPDATE SET
  product_id = COALESCE(EXCLUDED.product_id, marketplace_listings.product_id),
  pret_minim_override = COALESCE(
    marketplace_listings.pret_minim_override,
    EXCLUDED.pret_minim_override
  ),
  updated_at = NOW();

ALTER TABLE catalog_products DROP COLUMN IF EXISTS pret_minim_override;
