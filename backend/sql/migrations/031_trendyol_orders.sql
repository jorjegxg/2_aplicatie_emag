-- Comenzile Trendyol (o linie pe rând), pentru prognoza vânzărilor.
-- line_id = lineId de la Trendyol (Base îl dă ca transaction_id), deci aceeași linie
-- venită direct sau prin Base nu se dublează.
CREATE TABLE IF NOT EXISTS trendyol_order_lines (
  line_id BIGINT PRIMARY KEY,
  order_number TEXT NOT NULL,
  package_id BIGINT,
  status TEXT,
  order_date TIMESTAMPTZ,
  sku TEXT,
  barcode TEXT,
  name TEXT,
  quantity NUMERIC(12, 3),
  price NUMERIC(12, 4),
  commission NUMERIC(12, 4),
  currency TEXT,
  catalog_product_id INTEGER REFERENCES catalog_products (id) ON DELETE SET NULL,
  received_via TEXT,
  raw JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trendyol_lines_product
  ON trendyol_order_lines (catalog_product_id, order_date);
