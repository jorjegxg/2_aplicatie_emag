-- marketplace_listings tine doar override-uri locale eMAG; coloanele de mai jos erau
-- scrise exclusiv de calea non-eMAG (Trendyol), eliminata odata cu aceasta migratie.
ALTER TABLE marketplace_listings
  DROP COLUMN IF EXISTS part_number,
  DROP COLUMN IF EXISTS part_number_key,
  DROP COLUMN IF EXISTS name,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS brand,
  DROP COLUMN IF EXISTS ean,
  DROP COLUMN IF EXISTS id_familie,
  DROP COLUMN IF EXISTS sale_price,
  DROP COLUMN IF EXISTS recommended_price,
  DROP COLUMN IF EXISTS min_sale_price,
  DROP COLUMN IF EXISTS max_sale_price,
  DROP COLUMN IF EXISTS general_stock,
  DROP COLUMN IF EXISTS currency;
