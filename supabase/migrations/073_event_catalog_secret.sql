-- The unguessable part of a trip's catalogue URL.
--
-- Derived from the event name until now, which made every link permanent: the
-- only way to revoke one was to rotate a salt shared by every trip. Stored, a
-- leaked link is retired by giving that one trip a new secret.
ALTER TABLE events ADD COLUMN IF NOT EXISTS catalog_secret TEXT;

-- Two trips must never share a link. Partial, because most events have no
-- secret until somebody asks for the catalogue.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_catalog_secret
  ON events (catalog_secret) WHERE catalog_secret IS NOT NULL;

COMMENT ON COLUMN events.catalog_secret IS
  'Random path segment for /katalog/<secret>. Null until the link is first asked for; replaced to revoke.';
