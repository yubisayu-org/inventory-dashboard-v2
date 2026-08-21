-- The codes that tell one shipping route from another.
--
-- A parcel's route is read off the front of its receipt — HC in a suitcase,
-- CJI by air, MNC by sea — which was fine while those three strings lived in
-- the code, and stops being fine the moment a forwarder changes or a fourth
-- route appears. They are the owner's naming, so they belong in Settings.
--
-- The windows travel with the prefix: how long that route usually takes
-- (warn_days) and when a box is a problem rather than merely slow
-- (late_days). Keeping them together means one screen answers "what do we
-- call it, and when should I chase it".
--
-- `key` is stable and internal — the UI and the seed refer to routes by it —
-- while label and prefix are the owner's to change.

CREATE TABLE IF NOT EXISTS dispatch_routes (
  key        TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  prefix     TEXT NOT NULL,
  warn_days  INTEGER NOT NULL CHECK (warn_days > 0),
  late_days  INTEGER NOT NULL CHECK (late_days > 0),
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A prefix has to be unambiguous, or a receipt would belong to two routes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_routes_prefix
  ON dispatch_routes (upper(prefix));

-- The three in use, with the windows the owner gave: air chase at 4 weeks and
-- worry at 8, sea chase at 8 and worry at 12. Hand carry has no stated pair —
-- a suitcase either lands with the person or it never travelled — so 1 and 2
-- weeks stand until someone says otherwise.
INSERT INTO dispatch_routes (key, label, prefix, warn_days, late_days, position) VALUES
  ('hc',  'Hand carry', 'HC',  7,  14, 1),
  ('cji', 'Air cargo',  'CJI', 28, 56, 2),
  ('mnc', 'Sea cargo',  'MNC', 56, 84, 3)
ON CONFLICT (key) DO NOTHING;

GRANT SELECT ON dispatch_routes TO app_runtime;
