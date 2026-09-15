-- Antet comenzi eMAG, salvat la fiecare webhook / poll (liniile raman in order_line_history).
CREATE TABLE IF NOT EXISTS emag_orders (
  order_id BIGINT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'emag',
  status INTEGER,
  order_date TIMESTAMPTZ,
  modified_at TIMESTAMPTZ,
  payment_mode_id INTEGER,
  payment_mode TEXT,
  customer_name TEXT,
  currency TEXT,
  products_total NUMERIC(12, 4),
  products_total_vat NUMERIC(12, 4),
  shipping_tax NUMERIC(12, 4),
  vouchers_total NUMERIC(12, 4),
  raw JSONB,
  received_via TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emag_orders_date
  ON emag_orders (order_date DESC);

ALTER TABLE order_line_history ADD COLUMN IF NOT EXISTS vat NUMERIC(6, 4);
ALTER TABLE order_line_history
  ADD COLUMN IF NOT EXISTS catalog_product_id INTEGER REFERENCES catalog_products (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_order_line_order
  ON order_line_history (order_id);
