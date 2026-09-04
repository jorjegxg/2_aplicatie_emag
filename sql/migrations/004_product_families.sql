-- Lookup: acelasi id_familie => acelasi familie (FK compus pe catalog/listings).

CREATE TABLE IF NOT EXISTS product_families (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  UNIQUE (id, name)
);

-- schema.sql poate crea tabelul fara UNIQUE; FK compus din 004 are nevoie de el
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_families_id_name_key'
  ) THEN
    ALTER TABLE product_families
      ADD CONSTRAINT product_families_id_name_key UNIQUE (id, name);
  END IF;
END $$;

-- Conflict: acelasi id cu 2 nume diferite (catalog + listings)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT id_familie, familie
      FROM catalog_products
      WHERE id_familie IS NOT NULL AND familie IS NOT NULL
      UNION
      SELECT id_familie, familie
      FROM marketplace_listings
      WHERE id_familie IS NOT NULL AND familie IS NOT NULL
    ) s
    GROUP BY id_familie
    HAVING COUNT(DISTINCT familie) > 1
  ) THEN
    RAISE EXCEPTION
      'product_families seed blocked: same id_familie has multiple familie values';
  END IF;
END $$;

INSERT INTO product_families (id, name)
SELECT DISTINCT id_familie, familie
FROM (
  SELECT id_familie, familie
  FROM catalog_products
  WHERE id_familie IS NOT NULL AND familie IS NOT NULL
  UNION
  SELECT id_familie, familie
  FROM marketplace_listings
  WHERE id_familie IS NOT NULL AND familie IS NOT NULL
) s
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'catalog_products_familie_fk'
  ) THEN
    ALTER TABLE catalog_products
      ADD CONSTRAINT catalog_products_familie_fk
      FOREIGN KEY (id_familie, familie)
      REFERENCES product_families (id, name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_listings_familie_fk'
  ) THEN
    ALTER TABLE marketplace_listings
      ADD CONSTRAINT marketplace_listings_familie_fk
      FOREIGN KEY (id_familie, familie)
      REFERENCES product_families (id, name);
  END IF;
END $$;
