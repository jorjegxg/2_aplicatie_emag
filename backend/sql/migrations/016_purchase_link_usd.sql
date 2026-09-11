-- Link sursa achizitie + pret cumparare in USD (editabile in tabelul principal).
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS link_cumparare TEXT;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS pret_cumparare_usd NUMERIC(12, 4);
