-- Shelves waiting for the bot to post them.
--
-- The dashboard cannot send a WhatsApp message: the socket belongs to the
-- worker, which is a different process on a different machine. So an upload
-- writes its intent here and the worker acts on it — a queue rather than a call,
-- which also means a shelf uploaded while the worker is down is posted when it
-- comes back rather than lost.
CREATE TABLE IF NOT EXISTS wa_outbox (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES wa_posts(id) ON DELETE CASCADE,
  group_jid  TEXT NOT NULL,
  -- pending → sent, or failed with a reason. Failed rows are kept: "why did
  -- this rack never appear in the group" is a question worth answering.
  state      TEXT NOT NULL DEFAULT 'pending'
             CHECK (state IN ('pending', 'sent', 'failed')),
  error      TEXT NOT NULL DEFAULT '',
  -- The message the bot ended up sending, so a customer's reply quoting it can
  -- be resolved back to this shelf.
  message_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at    TIMESTAMPTZ
);

-- One send per shelf, ever. A retry updates this row rather than adding a
-- second, so a shelf cannot appear in the group twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_outbox_post ON wa_outbox (post_id);
CREATE INDEX IF NOT EXISTS idx_wa_outbox_pending ON wa_outbox (id) WHERE state = 'pending';
