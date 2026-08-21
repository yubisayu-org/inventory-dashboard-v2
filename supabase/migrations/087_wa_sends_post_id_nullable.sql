-- Deleting a catalogue post must never destroy the record of a code a
-- customer actually saw and could have ordered against — reissuing "K12" to
-- a different product after the original was deleted is exactly the
-- confusion this prevents. A send that never went out (message_id = '')
-- carries no such risk and gets hard-deleted (application code, not this
-- migration) instead, freeing its codes for reuse.
ALTER TABLE wa_sends ALTER COLUMN post_id DROP NOT NULL;
ALTER TABLE wa_sends DROP CONSTRAINT wa_sends_post_id_fkey;
ALTER TABLE wa_sends ADD CONSTRAINT wa_sends_post_id_fkey
  FOREIGN KEY (post_id) REFERENCES catalogue_posts(id) ON DELETE SET NULL;
