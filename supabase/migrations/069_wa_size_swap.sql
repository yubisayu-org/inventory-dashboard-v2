-- Agreeing a different size than the one asked for.
--
-- A shelf runs out of 95 and the customer takes 100 instead. Until now the size
-- a claim belonged to was read out of the customer's own note every time slots
-- were recomputed, so there was nowhere to put an agreement: rewriting her words
-- would put them on her invoice, and appending "-> Size 100" would still be read
-- back as 95, since the parser takes the first size it finds.

-- The agreed size, when one has been agreed. NULL means "read the note", which
-- is every claim nobody has renegotiated — the overwhelming majority.
ALTER TABLE wa_claims ADD COLUMN IF NOT EXISTS size TEXT;

COMMENT ON COLUMN wa_claims.size IS
  'Agreed size, overriding the one parsed from note. NULL = follow the note.';

-- An offer of a different size, waiting on the customer's answer.
--
-- Needed only for the cold case: the owner proposes a size the customer never
-- mentioned, so nobody has her consent yet and a reaction has to fetch it. When
-- she already wrote "kalau 95 nggak ada 100 juga boleh" the owner acts on that
-- directly and no row is written here.
CREATE TABLE IF NOT EXISTS wa_size_offers (
  id          SERIAL PRIMARY KEY,
  claim_id    INTEGER NOT NULL REFERENCES wa_claims(id) ON DELETE CASCADE,
  -- What was offered. Already normalized, so accepting is a copy rather than a
  -- second parse of the owner's sentence.
  size        TEXT NOT NULL,
  -- The owner's message. Her reaction lands on this, and it is the only handle
  -- tying that reaction back to a claim.
  group_jid   TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when she answers either way. Kept rather than deleted: a second offer on
  -- the same shelf should be able to see that the first was declined.
  answered_at TIMESTAMPTZ,
  accepted    BOOLEAN
);

-- One offer per message, so a reaction resolves to exactly one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_size_offers_message
  ON wa_size_offers (group_jid, message_id);

CREATE INDEX IF NOT EXISTS idx_wa_size_offers_claim ON wa_size_offers (claim_id);
