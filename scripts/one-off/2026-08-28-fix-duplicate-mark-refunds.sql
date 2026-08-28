-- One-off, 28 Aug 2026. Run once against production, then this file is history.
--
-- Five products marked out of stock inside 120ms priced their refunds against
-- an invoice the others had already reduced, so each claimed the whole drop.
-- Fixed in code by 4d44eee (each refund bounded by its own reduction) and
-- 48d041e (one refund per customer, grown by each mark) — but code never
-- rewrites rows that already exist, and these nine do.
--
--   lydouble25       rows say 3.473.000   owed   795.000
--   tamrellamorina   rows say   596.000   owed   298.000
--   aisasekartaji    rows say   412.000   owed   253.000
--
-- Verified 28 Aug: all nine still pending, nothing transferred.
--
-- Correct the three customers whose marks were priced against each other's
-- reductions on 28 Aug 03:51:18. One refund each, at what she is actually
-- owed; the duplicates are cancelled rather than deleted so the record shows
-- what happened.
--
-- Run inside a transaction and check the SELECT before COMMIT.
BEGIN;

-- lydouble25 · LSJP202608 · 5 items, Rp 795.000
UPDATE refunds SET refund_amount = 795000,
       note = 'Cooling Towel, Bucket Hat, Simple Cap, Bottle Case, Wire Tongs — 5 item',
       updated_at = NOW()
 WHERE id = 749;
UPDATE refunds SET status = 'cancelled',
       note = COALESCE(note,'') || ' — digabung ke refund #749 (duplikat harga)',
       updated_at = NOW()
 WHERE id IN (753, 754, 755, 763);

-- tamrellamorina · LSJP202608 · 2 items, Rp 298.000
UPDATE refunds SET refund_amount = 298000,
       note = 'Bottle Case with Shoulder Black + Green — 2 item',
       updated_at = NOW()
 WHERE id = 746;
UPDATE refunds SET status = 'cancelled',
       note = COALESCE(note,'') || ' — digabung ke refund #746 (duplikat harga)',
       updated_at = NOW()
 WHERE id = 762;

-- aisasekartaji · LSJP202608 · 2 items, Rp 253.000
UPDATE refunds SET refund_amount = 253000,
       note = 'Juliene Shredder + Mesh Bag in Bag A5 Grey — 2 item',
       updated_at = NOW()
 WHERE id = 748;
UPDATE refunds SET status = 'cancelled',
       note = COALESCE(note,'') || ' — digabung ke refund #748 (duplikat harga)',
       updated_at = NOW()
 WHERE id = 752;

-- Check before committing: each customer should show one live row whose
-- amount equals her surplus, and nothing else outstanding.
SELECT id, customer, refund_amount, status, note
  FROM refunds
 WHERE id IN (746,748,749,752,753,754,755,762,763)
 ORDER BY customer, id;

COMMIT;
