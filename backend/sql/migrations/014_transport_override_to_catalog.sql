-- alte_costuri (override per produs pentru "Pret transport") se muta de pe
-- marketplace_listings pe catalog_products, ca transport_override.
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS transport_override NUMERIC(12, 4);

UPDATE catalog_products c
SET transport_override = COALESCE(c.transport_override, l.alte_costuri)
FROM marketplace_listings l
WHERE l.channel = 'emag'
  AND l.external_id = c.emag_offer_id
  AND l.alte_costuri IS NOT NULL;

ALTER TABLE marketplace_listings DROP COLUMN IF EXISTS alte_costuri;
