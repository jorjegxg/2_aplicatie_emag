-- Safety: DB-uri create cu fresh-skip au schema_version=11 fara coloana.
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS source_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS product_images_source_uidx
  ON product_images (product_id, source_url)
  WHERE source_url IS NOT NULL;
