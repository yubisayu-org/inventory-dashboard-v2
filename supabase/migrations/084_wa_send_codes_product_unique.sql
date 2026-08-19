-- A double-click (or a slow round trip + an impatient second click) on the
-- same product in the composer's search picker could attach it twice under
-- two different codes: the only "already added" guard was client-side
-- (alreadyAddedIds), which doesn't grey a product out until the attach
-- round-trip AND a follow-up list refresh both complete — a window wide
-- enough for two concurrent attachProductToSend calls to both commit before
-- either sees the other's row. The result was two wa_send_codes rows for
-- the same (send, product), each independently claimable by a different
-- customer, with no removal route to undo it once sent. See the final
-- whole-branch review's finding 6.
--
-- This unique index closes the race at the database layer regardless of
-- client behaviour; attachProductToSend (lib/db/wa-sends.ts) now inserts
-- with ON CONFLICT (send_id, product_id) DO NOTHING and falls back to
-- returning the winner's already-committed row instead of erroring or
-- minting a second code.
ALTER TABLE wa_send_codes
  ADD CONSTRAINT wa_send_codes_send_product_unique UNIQUE (send_id, product_id);
