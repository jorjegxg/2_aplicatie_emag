-- Platforma eMAG a comenzii (ro/hu/bg); comenzile HU/BG vin din API-ul platformei respective.
ALTER TABLE emag_orders ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'ro';
ALTER TABLE order_line_history ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'ro';
