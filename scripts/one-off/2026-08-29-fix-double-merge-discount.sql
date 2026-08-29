-- One merge, two credits: the production repair.
--
-- reconcileParcelPlan computed the pairing's saving for the whole group and
-- wrote it on the trip the call named -- once per trip. hanapanjaitan saved one
-- kilo, Rp 14.000, and was credited Rp 28.000:
--
--   LSCN202606  1.390 g  invoiced 2 kg     Rp 28.000
--   LSFT202607    100 g  invoiced 1 kg     Rp 14.000   invoiced Rp 42.000
--   one box     1.490 g  billed   2 kg     Rp 28.000   saved    Rp 14.000
--
-- The code fix (this session) makes one trip of a group hold the credit, chosen
-- by name -- LSCN202606 here. This deletes the other one. Her LSFT202607
-- invoice goes UP by Rp 14.000, which is money the shop was not owed to give
-- away; both trips currently read as settled, so she will show Rp 14.000
-- outstanding on LSFT202607 afterwards. That is the point of running it.
--
-- Run against production. Read the SELECT before the DELETE.

-- What is there now. Expect two rows, -14000 each.
SELECT event, amount, description, auto
  FROM adjustments
 WHERE lower(replace(customer, '@', '')) = 'hanapanjaitan'
   AND auto AND description LIKE 'Gabung ongkir dengan%'
 ORDER BY event;

-- Anyone else in the same shape. Expect no rows other than hers; if this
-- returns somebody new, stop and look before deleting anything.
SELECT lower(replace(customer, '@', '')) AS cust, count(*) AS rows_written, SUM(amount)::int AS credited
  FROM adjustments
 WHERE auto AND description LIKE 'Gabung ongkir dengan%'
 GROUP BY 1 HAVING count(*) > 1;

BEGIN;

-- Keep the first trip of the pairing by name, delete the rest. Same rule the
-- code now follows, so a later reconcile agrees with this and changes nothing.
DELETE FROM adjustments a
 WHERE a.auto
   AND a.description LIKE 'Gabung ongkir dengan%'
   AND a.event <> (
     SELECT MIN(b.event) FROM adjustments b
      WHERE b.auto AND b.description LIKE 'Gabung ongkir dengan%'
        AND lower(replace(b.customer, '@', '')) = lower(replace(a.customer, '@', ''))
   );

-- Expect exactly one row per customer, and -14000 for hanapanjaitan.
SELECT lower(replace(customer, '@', '')) AS cust, event, amount::int
  FROM adjustments
 WHERE auto AND description LIKE 'Gabung ongkir dengan%'
 ORDER BY 1, 2;

COMMIT;
