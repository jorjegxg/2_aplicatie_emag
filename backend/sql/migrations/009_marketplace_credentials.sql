CREATE TABLE IF NOT EXISTS marketplace_credentials (
  channel TEXT PRIMARY KEY,
  payload_enc TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
