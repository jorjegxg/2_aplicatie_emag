-- Ce set de poze am trimis ultima data pe fiecare platforma eMAG.
-- fingerprint = hash-ul listei ordonate de stored_name din setul efectiv al platformei.
CREATE TABLE IF NOT EXISTS product_images_push_state (
  product_id INTEGER NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  pushed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, platform)
);
