-- Normalize: doar id_familie FK → product_families(id); drop text denormalizat.

ALTER TABLE catalog_products
  DROP CONSTRAINT IF EXISTS catalog_products_familie_fk;

ALTER TABLE marketplace_listings
  DROP CONSTRAINT IF EXISTS marketplace_listings_familie_fk;

ALTER TABLE product_families
  DROP CONSTRAINT IF EXISTS product_families_id_name_key;

-- Orfani: id_familie setat fara rand in lookup (MATCH SIMPLE pe FK vechi)
INSERT INTO product_families (id, name)
SELECT DISTINCT s.id_familie, 'Familie ' || s.id_familie
FROM (
  SELECT id_familie FROM catalog_products WHERE id_familie IS NOT NULL
  UNION
  SELECT id_familie FROM marketplace_listings WHERE id_familie IS NOT NULL
) s
WHERE NOT EXISTS (
  SELECT 1 FROM product_families pf WHERE pf.id = s.id_familie
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE catalog_products DROP COLUMN IF EXISTS familie;
ALTER TABLE marketplace_listings DROP COLUMN IF EXISTS familie;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'catalog_products_id_familie_fk'
  ) THEN
    ALTER TABLE catalog_products
      ADD CONSTRAINT catalog_products_id_familie_fk
      FOREIGN KEY (id_familie) REFERENCES product_families (id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_listings_id_familie_fk'
  ) THEN
    ALTER TABLE marketplace_listings
      ADD CONSTRAINT marketplace_listings_id_familie_fk
      FOREIGN KEY (id_familie) REFERENCES product_families (id);
  END IF;
END $$;
