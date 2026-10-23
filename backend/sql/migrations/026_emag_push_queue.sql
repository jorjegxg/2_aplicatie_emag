-- Coada de trimiteri eMAG care nu se pot face imediat (de ex. BG doar după ce HU a terminat validarea).
-- Serviciul `queue` (queue-worker.js) o verifică periodic: trimite doar când a sosit ora, când trimiterea
-- de care depinde s-a validat și când nicio altă platformă a produsului nu e în validare (status 11).
-- name/description NULL = nu se schimbă (pe RO, cu name_from_app/description_from_app se iau din catalog).
CREATE TABLE IF NOT EXISTS emag_push_queue (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ro', 'hu', 'bg')),
  send_images BOOLEAN NOT NULL DEFAULT true,
  name TEXT,
  description TEXT,
  name_from_app BOOLEAN NOT NULL DEFAULT false,
  description_from_app BOOLEAN NOT NULL DEFAULT false,
  characteristics JSONB,
  not_before TIMESTAMPTZ NOT NULL DEFAULT now(),
  after_id INTEGER REFERENCES emag_push_queue(id) ON DELETE SET NULL,
  -- retrimite chiar dacă platforma proprie e în validare (actualizare blocată, de ex. pe link-uri de poze moarte)
  replace_pending BOOLEAN NOT NULL DEFAULT false,
  -- pending -> sent (în validare) -> done; sau skipped (deja la zi), failed, cancelled
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'done', 'skipped', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  seen_pending BOOLEAN NOT NULL DEFAULT false,
  note TEXT,
  last_message TEXT,
  last_check_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emag_push_queue_open
  ON emag_push_queue (status, not_before)
  WHERE status IN ('pending', 'sent');
