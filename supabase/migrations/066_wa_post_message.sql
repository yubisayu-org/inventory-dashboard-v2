-- How a reply finds the post it is replying to.
--
-- A quoted message carries only the original's id, so without this the worker
-- would have to re-download each reply's quoted image and match it against
-- every post — expensive, and wrong as soon as two shelves look alike.
--
-- Both columns default empty: posts created from the dashboard were never sent
-- to a group and have neither.
ALTER TABLE wa_posts ADD COLUMN IF NOT EXISTS message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE wa_posts ADD COLUMN IF NOT EXISTS group_jid TEXT NOT NULL DEFAULT '';

-- The lookup the worker does on every single reply.
CREATE INDEX IF NOT EXISTS idx_wa_posts_message
  ON wa_posts (group_jid, message_id) WHERE message_id <> '';
