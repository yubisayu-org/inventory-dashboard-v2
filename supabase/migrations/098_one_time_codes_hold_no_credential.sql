-- Stop the one-time code table holding a live credential.
--
-- It stored the raw 90-day session token in plaintext, so a dump of this one
-- small table yielded working sessions — undoing the hash-everything rule the
-- invite and session stores follow. It now holds a customer id and a hashed
-- code: the session is minted when the code is spent, so there is nothing here
-- worth stealing.
DELETE FROM customer_one_time_codes;

ALTER TABLE customer_one_time_codes
  DROP COLUMN IF EXISTS session_token,
  ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE;

-- Codes outlive their minute only if nobody sweeps them.
CREATE INDEX IF NOT EXISTS idx_customer_one_time_codes_expiry
  ON customer_one_time_codes (expires_at);
