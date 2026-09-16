-- ID-urile ofertelor eMAG pot avea 13 cifre.
ALTER TABLE product_pret_emag_history
  ALTER COLUMN offer_id TYPE BIGINT
  USING offer_id::BIGINT;
