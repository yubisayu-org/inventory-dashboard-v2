-- Shops that are done taking orders, while the trip carries on.
--
-- A trip covers several shops and they do not finish together: Nishimatsuya is
-- walked and closed on Tuesday while Birthday is still open on Thursday. Until
-- now the catalogue showed every shelf of a running trip, so a customer could
-- mark a rack nobody is going back to.
--
-- Store rather than shelf, because that is the unit the owner works in — one
-- toggle per shop rather than one per rack.
CREATE TABLE IF NOT EXISTS wa_store_closures (
  event      TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE CASCADE,
  -- Lower-cased on the way in: the store name is typed by hand when a capture
  -- window opens, so "Birthday" and "BIRTHDAY" are one shop and must close as
  -- one.
  store      TEXT NOT NULL,
  closed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event, store)
);

COMMENT ON TABLE wa_store_closures IS
  'A shop hidden from the catalogue for one trip. Claims already in WhatsApp are unaffected.';
