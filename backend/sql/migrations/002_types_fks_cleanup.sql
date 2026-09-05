-- Migrare idempotentă: tipuri corecte, FK ON DELETE, unificare override → listings.

-- 1) Merge override-uri legacy în marketplace_listings (canal emag)
DO $$
BEGIN
  IF to_regclass('public.product_alte_costuri') IS NOT NULL THEN
    UPDATE marketplace_listings ml
    SET alte_costuri = p.alte_costuri
    FROM product_alte_costuri p
    WHERE ml.channel = 'emag'
      AND ml.external_id = p.offer_id::text
      AND ml.alte_costuri IS NULL
      AND p.alte_costuri IS NOT NULL;
  END IF;

  IF to_regclass('public.product_pret_minim') IS NOT NULL THEN
    UPDATE marketplace_listings ml
    SET pret_minim_override = p.pret_minim
    FROM product_pret_minim p
    WHERE ml.channel = 'emag'
      AND ml.external_id = p.offer_id::text
      AND ml.pret_minim_override IS NULL
      AND p.pret_minim IS NOT NULL;
  END IF;

  IF to_regclass('public.product_procentaj_emag') IS NOT NULL THEN
    UPDATE marketplace_listings ml
    SET
      procentaj_emag = COALESCE(ml.procentaj_emag, p.procentaj_emag),
      commission_value = COALESCE(ml.commission_value, p.commission_value),
      commission_fetched_at = COALESCE(ml.commission_fetched_at, p.fetched_at)
    FROM product_procentaj_emag p
    WHERE ml.channel = 'emag'
      AND ml.external_id = p.offer_id::text;
  END IF;
END $$;

DROP TABLE IF EXISTS product_alte_costuri;
DROP TABLE IF EXISTS product_pret_minim;
DROP TABLE IF EXISTS product_procentaj_emag;

-- 2) Tipuri bani / stoc / procent → NUMERIC
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'double precision'
      AND (
        column_name LIKE '%price%'
        OR column_name LIKE '%pret%'
        OR column_name LIKE '%cost%'
        OR column_name LIKE '%procentaj%'
        OR column_name LIKE '%commission%'
        OR column_name LIKE '%stock%'
        OR column_name LIKE '%mult_%'
        OR column_name IN ('quantity', 'numar_produse', 'sale_price', 'recommended_price')
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE NUMERIC(12,4) USING %I::numeric',
      r.table_name, r.column_name, r.column_name
    );
  END LOOP;
END $$;

-- 3) Date TEXT → TIMESTAMPTZ
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'text'
      AND column_name IN (
        'created_at', 'updated_at', 'fetched_at', 'recorded_at',
        'commission_fetched_at', 'ts', 'order_date'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING NULLIF(%I, '''')::timestamptz',
      r.table_name, r.column_name, r.column_name
    );
  END LOOP;
END $$;

-- 4) JSON TEXT → JSONB
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'marketplace_listings'
      AND column_name = 'stock_json' AND data_type = 'text'
  ) THEN
    ALTER TABLE marketplace_listings
      ALTER COLUMN stock_json TYPE JSONB
      USING CASE
        WHEN stock_json IS NULL OR btrim(stock_json) = '' THEN NULL
        ELSE stock_json::jsonb
      END;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'marketplace_listings'
      AND column_name = 'handling_time_json' AND data_type = 'text'
  ) THEN
    ALTER TABLE marketplace_listings
      ALTER COLUMN handling_time_json TYPE JSONB
      USING CASE
        WHEN handling_time_json IS NULL OR btrim(handling_time_json) = '' THEN NULL
        ELSE handling_time_json::jsonb
      END;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'marketplace_snapshots'
      AND column_name = 'payload_json' AND data_type = 'text'
  ) THEN
    ALTER TABLE marketplace_snapshots
      ALTER COLUMN payload_json TYPE JSONB
      USING CASE
        WHEN payload_json IS NULL OR btrim(payload_json) = '' THEN NULL
        ELSE payload_json::jsonb
      END;
  END IF;
END $$;

-- 5) channel pe istoric preț
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'product_pret_emag_history'
      AND column_name = 'channel' AND is_nullable = 'YES'
  ) THEN
    UPDATE product_pret_emag_history SET channel = 'emag' WHERE channel IS NULL;
    ALTER TABLE product_pret_emag_history
      ALTER COLUMN channel SET DEFAULT 'emag',
      ALTER COLUMN channel SET NOT NULL;
  END IF;
END $$;

-- 6) FK product_id ON DELETE SET NULL
DO $$
DECLARE
  conname TEXT;
BEGIN
  UPDATE marketplace_listings ml
  SET product_id = NULL
  WHERE product_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM catalog_products c WHERE c.id = ml.product_id
    );

  SELECT tc.constraint_name INTO conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = 'public'
    AND tc.table_name = 'marketplace_listings'
    AND tc.constraint_type = 'FOREIGN KEY'
    AND kcu.column_name = 'product_id'
  LIMIT 1;

  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE marketplace_listings DROP CONSTRAINT %I', conname);
  END IF;

  ALTER TABLE marketplace_listings
    ADD CONSTRAINT marketplace_listings_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES catalog_products(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 7) Indexuri lipsă
CREATE INDEX IF NOT EXISTS idx_products_cod_lower
  ON products (LOWER(cod_produs));

CREATE INDEX IF NOT EXISTS idx_listings_channel_ext
  ON marketplace_listings (channel, external_id);

CREATE INDEX IF NOT EXISTS idx_pret_emag_hist_channel
  ON product_pret_emag_history (channel, offer_id, recorded_at DESC);
