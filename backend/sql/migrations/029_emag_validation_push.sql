-- Retrimiterile făcute de serviciul `validari` pe eMAG, cu textele și pozele din Base.
CREATE TABLE IF NOT EXISTS emag_validation_push (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES catalog_products(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  diff TEXT,
  sent BOOLEAN NOT NULL DEFAULT false,
  ok BOOLEAN,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emag_validation_push_product ON emag_validation_push (product_id, platform, created_at DESC);
