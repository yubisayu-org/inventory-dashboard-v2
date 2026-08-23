-- A route can answer to more than one code.
--
-- The sea forwarder books the same freight under MNC and MU, and until now a
-- route held exactly one prefix, so the second series fell through to "Other"
-- along with everything else nobody had claimed. That bucket is where the
-- transit warnings switch off — an unmatched receipt has no window to be late
-- against — so the codes that were merely unlisted looked the same as the ones
-- that were wrong.
--
-- A child table rather than an array column, because the guarantee the original
-- migration cared about — "a prefix has to be unambiguous, or a receipt would
-- belong to two routes" — is then just a primary key.
--
-- dispatch_routes.prefix stays for now and keeps holding the first code. The
-- migrations here are applied by hand before the deploy that reads them, so
-- dropping the column in this migration would break the running app in the gap
-- between the two. A later migration removes it once nothing reads it.
--
-- Re-running is safe.

-- The keys were named after the single prefix each route had, so `mnc` and the
-- code MNC were the same letters doing different jobs — one the route's
-- permanent identity, the other a string written on a parcel. The moment a
-- route answers to two codes that reading breaks down, so the identities are
-- renamed to something no receipt could be mistaken for. Hand carry keeps `hc`,
-- which never resembled its own code any more than the others but reads fine.
--
-- Safe to rename: no order, receipt or shipment stores a route key. A parcel's
-- route is worked out from the front of its receipt every time it is read, so
-- there is nothing to orphan.
UPDATE dispatch_routes SET key = 'air' WHERE key = 'cji';
UPDATE dispatch_routes SET key = 'sea' WHERE key = 'mnc';

CREATE TABLE IF NOT EXISTS dispatch_route_prefixes (
  prefix    TEXT PRIMARY KEY,
  route_key TEXT NOT NULL REFERENCES dispatch_routes(key) ON UPDATE CASCADE ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE dispatch_route_prefixes IS
  'Receipt codes that identify a route. The primary key is what stops two '
  'routes claiming the same code.';

CREATE INDEX IF NOT EXISTS idx_dispatch_route_prefixes_route
  ON dispatch_route_prefixes (route_key);

-- Carry over what each route already answers to.
INSERT INTO dispatch_route_prefixes (prefix, route_key, position)
  SELECT upper(trim(prefix)), key, 0 FROM dispatch_routes
 ON CONFLICT (prefix) DO NOTHING;

GRANT SELECT ON dispatch_route_prefixes TO app_runtime;
