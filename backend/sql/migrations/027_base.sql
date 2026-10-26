-- Totul pleacă prin Base (BaseLinker), nu direct spre eMAG/Trendyol.
-- product_texts: titlul/descrierea pe fiecare limbă, verificate în pagina „Pregătire Base” înainte de trimitere.
-- RO pornește din catalog_products; HU/BG din ultimul text pus în emag_push_queue pentru platforma respectivă.
CREATE TABLE IF NOT EXISTS product_texts (
  product_id INTEGER NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  lang TEXT NOT NULL CHECK (lang IN ('ro', 'hu', 'bg', 'en')),
  name TEXT,
  description TEXT,
  characteristics JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, lang)
);

INSERT INTO product_texts (product_id, lang, name, description)
SELECT id, 'ro', nume, descriere FROM catalog_products
ON CONFLICT (product_id, lang) DO NOTHING;

INSERT INTO product_texts (product_id, lang, name, description)
SELECT DISTINCT ON (product_id, platform) product_id, platform, name, description
FROM emag_push_queue
WHERE platform IN ('hu', 'bg') AND (name IS NOT NULL OR description IS NOT NULL)
  AND status <> 'cancelled'
ORDER BY product_id, platform, id DESC
ON CONFLICT (product_id, lang) DO NOTHING;

-- Legătura cu produsul din catalogul Base și ce s-a trimis ultima dată (amprenta payload-ului).
CREATE TABLE IF NOT EXISTS base_products (
  product_id INTEGER PRIMARY KEY REFERENCES catalog_products(id) ON DELETE CASCADE,
  base_product_id BIGINT,
  sku TEXT,
  last_pushed_at TIMESTAMPTZ,
  last_push_fingerprint TEXT,
  last_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
