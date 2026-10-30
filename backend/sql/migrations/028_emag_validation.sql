-- Urmărirea validărilor eMAG pe RO/HU/BG (serviciul `validari`, doar citire de pe eMAG).
CREATE TABLE IF NOT EXISTS emag_validation_state (
  product_id INTEGER NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ro', 'hu', 'bg')),
  offer_id BIGINT,
  status INTEGER,
  status_text TEXT,
  errors JSONB NOT NULL DEFAULT '[]',
  grp TEXT NOT NULL,
  since TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, platform)
);

CREATE TABLE IF NOT EXISTS emag_validation_events (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES catalog_products(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  from_status INTEGER,
  to_status INTEGER,
  from_grp TEXT,
  to_grp TEXT NOT NULL,
  message TEXT,
  notified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emag_validation_events_created ON emag_validation_events (created_at DESC);

-- Platforma pe care poți pune produsul acum (după ce cea dinainte a ieșit din validare).
CREATE TABLE IF NOT EXISTS emag_validation_next (
  product_id INTEGER PRIMARY KEY REFERENCES catalog_products(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
