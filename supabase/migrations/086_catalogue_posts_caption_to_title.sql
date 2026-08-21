-- "Caption" and wa_sends.title were two names for what's practically the
-- same text — the owner has confirmed they're meant to always match. Rename
-- rather than drop-and-lose: an existing post's caption becomes its title,
-- since for anything already sent that's already what it says on WhatsApp.
ALTER TABLE catalogue_posts RENAME COLUMN caption TO title;

-- The composer's own "Foto baru" upload never wrote its typed title back
-- onto the post (title only ever lived on wa_sends, caption stayed blank) —
-- so any post made that way just inherited an empty caption-turned-title
-- above. Backfill those from their most recent real send's title, so an
-- already-sent post doesn't lose "Kirim ulang" (which now requires a title)
-- over a gap that predates this migration, not anything the owner did.
UPDATE catalogue_posts p
SET title = latest.title
FROM (
  SELECT DISTINCT ON (post_id) post_id, title
  FROM wa_sends
  WHERE message_id <> ''
  ORDER BY post_id, id DESC
) latest
WHERE p.id = latest.post_id AND p.title = '';
