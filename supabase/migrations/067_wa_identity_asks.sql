-- Numbers the bot has already asked to identify themselves.
--
-- Asking is the one thing that makes this bot speak first rather than react, so
-- it must happen at most once per number, ever. Without a record of having
-- asked, every unresolved claim would ask again — the same customer pestered on
-- every shelf they claim, and the loudest activity pattern the number could
-- exhibit.
CREATE TABLE IF NOT EXISTS wa_identity_asks (
  -- Digits only, normalized. Not a foreign key: the whole point is that this
  -- number belongs to nobody on file yet.
  number      TEXT PRIMARY KEY,
  -- The message the bot sent, so an answer quoting it can be recognised.
  message_id  TEXT NOT NULL DEFAULT '',
  asked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when they answer. Kept rather than deleted so a second unanswered ask
  -- is never sent to someone who simply ignored the first.
  answered_at TIMESTAMPTZ
);
