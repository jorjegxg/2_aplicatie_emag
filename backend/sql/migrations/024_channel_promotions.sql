-- Promotiile active vazute la ultima preluare de pe canal (eMAG: campaign_id/name;
-- Trendyol: priceSeenByCustomer sub salePrice). Se rescriu la fiecare preluare.
CREATE TABLE IF NOT EXISTS channel_promotions (
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  promo_price NUMERIC(12, 4),
  sale_price NUMERIC(12, 4),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, external_id)
);
