-- Seturi de poze per platforma: 'en' = setul implicit (folosit cand platforma nu are poze proprii).
-- Pozele existente sunt in engleza, deci intra in setul 'en'.
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'en';

ALTER TABLE product_images DROP CONSTRAINT IF EXISTS product_images_platform_chk;
ALTER TABLE product_images
  ADD CONSTRAINT product_images_platform_chk
  CHECK (platform IN ('en', 'ro', 'bg', 'hu'));

CREATE INDEX IF NOT EXISTS idx_product_images_product_platform_sort
  ON product_images (product_id, platform, sort_order);

-- source_url e unic pe (produs, platforma): acelasi URL poate ajunge in mai multe seturi.
DROP INDEX IF EXISTS product_images_source_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS product_images_source_platform_uidx
  ON product_images (product_id, platform, source_url)
  WHERE source_url IS NOT NULL;
