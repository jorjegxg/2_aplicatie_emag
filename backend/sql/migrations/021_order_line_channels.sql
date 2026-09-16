ALTER TABLE order_line_history
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'emag';

CREATE INDEX IF NOT EXISTS idx_order_line_product_channel
  ON order_line_history (channel, product_id, order_date DESC);
