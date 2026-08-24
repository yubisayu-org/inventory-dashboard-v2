-- A realistic shelf, for looking at the Ready stock page.
--
-- LOCAL ONLY. Ready stock is `excess_purchase` rows whose `items` text matches
-- a product name — that match is what gives them a price, and an unpriced row
-- is never offered to a customer.
--
-- Three states, because the page distinguishes them:
--   unit_arrive = unit_buy   all here, buyable now
--   unit_arrive = 0          all still travelling
--   0 < unit_arrive < buy    some here, more coming — the one that belongs in
--                            both tabs at once
--
-- Re-running is safe: it clears its own rows first, by the same reason code.

\set ON_ERROR_STOP on

BEGIN;

DELETE FROM excess_purchase WHERE reason = 'shelf-seed';

INSERT INTO excess_purchase (items, unit_buy, unit_arrive, reason, receipt, created_at)
SELECT p.name, v.buy, v.arrive, 'shelf-seed', v.receipt,
       NOW() - (v.days_ago || ' days')::interval
  FROM (VALUES
    -- On the shelf now.
    ('Muji Boston Bag 38L Greige',        2, 2, 'JP2408-11', 12),
    ('Uniqlo Airism Tee Men L White',     4, 4, 'JP2408-11', 12),
    ('Laneige Water Sleeping Mask 70ml',  3, 3, 'KR2408-02',  9),
    ('Daiso Kitchen Tongs Silicone',      5, 5, 'JP2408-11',  9),
    -- Bought, still travelling.
    ('Anello Backpack Regular Navy',      2, 0, 'JP2409-03',  3),
    ('Innisfree Green Tea Serum 80ml',    4, 0, 'KR2409-01',  3),
    ('Stanley Quencher 1.2L Rose',        3, 0, 'CN2409-07',  2),
    -- Half landed: some to buy today, the rest on the way.
    ('Muji Shoulder Bag 9L Beige',        4, 2, 'JP2409-03',  4),
    ('Kakao Friends Ryan Plush 25cm',     6, 2, 'KR2409-01',  4),
    ('Miniso Sanrio Tumbler 500ml',       5, 3, 'CN2409-07',  2)
  ) AS v(name, buy, arrive, receipt, days_ago)
  -- Joined rather than trusted: a name that does not match a product would
  -- insert a row the customer can never see, which looks like a bug in the
  -- page rather than a typo in this file.
  JOIN products p ON p.name = v.name;

COMMIT;

\echo ''
\echo 'The shelf:'
SELECT items,
       unit_arrive AS ready,
       unit_buy - unit_arrive AS in_transit
  FROM excess_purchase
 WHERE reason = 'shelf-seed'
 ORDER BY unit_arrive = unit_buy DESC, unit_arrive > 0 DESC, items;
