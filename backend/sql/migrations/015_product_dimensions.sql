-- Dimensiuni / greutate produs (catalog local, editabile in tabelul principal).
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS greutate NUMERIC(12, 3);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS inaltime NUMERIC(12, 2);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS lungime NUMERIC(12, 2);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS latime NUMERIC(12, 2);
