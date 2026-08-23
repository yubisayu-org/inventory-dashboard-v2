-- A realistic order history for @fandrianr, for testing both sides at once.
--
-- LOCAL ONLY. It deletes every order, payment, shipment, adjustment, shipping
-- preference and catalogue request belonging to fandrianr before rebuilding
-- them, so it must never be pointed at production.
--
-- What it is for: exercising the customer catalogue and the owner dashboard
-- against data that behaves like a real customer's. That means whole trips of
-- three to eight lines drawn from two or three shops, rather than one line
-- each — with one-line trips, searching "muji" matches every trip you ever
-- made, which is exactly the fake-feeling history this replaces.
--
-- Three things are covered exhaustively, because each drives a different
-- screen:
--
--   1. every catalogue request status          → Request status page
--   2. every shipping choice she can make      → Shipping page + Ship screen
--   3. every shipping status × payment status  → Order history
--
-- Re-running is safe: it is a delete-then-insert, not an append.
--
--   psql "$DATABASE_URL" -f scripts/seed-fandrianr.sql

\set ON_ERROR_STOP on

BEGIN;

-- ── who, and at what rate ───────────────────────────────────────────
-- One warehouse, one rate: what is under test is the parcel plan, not the rate
-- card, and a second rate would only make the expected numbers harder to check
-- by hand.
CREATE TEMP TABLE seed_ctx ON COMMIT DROP AS
SELECT id AS customer_id, 'fandrianr'::text AS handle, 1::int AS warehouse_id, 15000::int AS rate
  FROM customers WHERE instagram_id = 'fandrianr';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM seed_ctx) THEN
    RAISE EXCEPTION 'No customer named fandrianr — nothing to seed';
  END IF;
END $$;

-- ── the trips, and what each one is for ─────────────────────────────
--
-- arrive/ship/hold are patterns, not counts, applied per line further down:
--   none  no line             half  the first half of the lines
--   full  every line          one   the first line only (hold)
--
-- Rows 1-20 are the order-history matrix: five shipping statuses across four
-- payment states. Rows 21-31 are the shipping choices, and every one of them
-- is paid and unshipped, because that is the only state in which she is
-- offered a choice at all.
CREATE TEMP TABLE seed_events (
  name          text PRIMARY KEY,
  eta           text,
  months_ago    int,
  arrive        text,
  ship          text,
  hold          text,
  resi          boolean,
  pay           numeric,     -- fraction of the invoice total
  mode          text,        -- NULL = never touched the shipping card
  merge_key     text,
  temp_address  text,
  purpose       text
) ON COMMIT DROP;

INSERT INTO seed_events VALUES
-- ── 1. order history: shipping status x payment status ──────────────
('LSJP202506','ETA MID JULY',   14,'half','none','none',false,0.00,NULL,NULL,NULL,'Pending / unpaid'),
('LSKR202506','ETA LATE JULY',  14,'half','none','none',false,0.40,NULL,NULL,NULL,'Pending / partial'),
('LSCN202506','ETA MID JULY',   13,'half','none','none',false,1.00,NULL,NULL,NULL,'Pending / paid'),
('LSJP202507','ETA LATE JULY',  13,'half','none','none',false,1.12,NULL,NULL,NULL,'Pending / overpaid'),
('LSKR202507','100% ARRIVED',   12,'full','none','none',false,0.00,NULL,NULL,NULL,'Processing / unpaid'),
('LSCN202507','100% ARRIVED',   12,'full','none','none',false,0.40,NULL,NULL,NULL,'Processing / partial'),
('LSJP202508','100% ARRIVED',   11,'full','none','none',false,1.00,NULL,NULL,NULL,'Processing / paid'),
('LSKR202508','100% ARRIVED',   11,'full','none','none',false,1.12,NULL,NULL,NULL,'Processing / overpaid'),
('LSCN202508','100% ARRIVED',   10,'full','half','none',true, 0.00,NULL,NULL,NULL,'Partially Shipped / unpaid'),
('LSJP202509','100% ARRIVED',   10,'full','half','none',true, 0.40,NULL,NULL,NULL,'Partially Shipped / partial'),
('LSKR202509','100% ARRIVED',    9,'full','half','none',true, 1.00,NULL,NULL,NULL,'Partially Shipped / paid'),
('LSCN202509','100% ARRIVED',    9,'full','half','none',true, 1.12,NULL,NULL,NULL,'Partially Shipped / overpaid'),
('LSJP202510','100% ARRIVED',    8,'full','full','none',false,0.00,NULL,NULL,NULL,'Shipped, no resi / unpaid'),
('LSKR202510','100% ARRIVED',    8,'full','full','none',false,0.40,NULL,NULL,NULL,'Shipped, no resi / partial'),
('LSCN202510','100% ARRIVED',    7,'full','full','none',false,1.00,NULL,NULL,NULL,'Shipped, no resi / paid'),
('LSJP202511','100% ARRIVED',    7,'full','full','none',false,1.12,NULL,NULL,NULL,'Shipped, no resi / overpaid'),
('LSKR202511','100% ARRIVED',    6,'full','full','none',true, 0.00,NULL,NULL,NULL,'Completed / unpaid'),
('LSCN202511','100% ARRIVED',    6,'full','full','none',true, 0.40,NULL,NULL,NULL,'Completed / partial'),
('LSJP202512','100% ARRIVED',    5,'full','full','none',true, 1.00,NULL,NULL,NULL,'Completed / paid'),
('LSKR202512','100% ARRIVED',    5,'full','full','none',true, 1.12,NULL,NULL,NULL,'Completed / overpaid'),
-- ── 2. the shipping choices ─────────────────────────────────────────
('LSJP202601','100% ARRIVED',    4,'full','none','none',false,1.00,'wait',NULL,NULL,'Ready to send / dashboard "ready"'),
('LSKR202601','70% ARRIVED',     4,'half','none','none',false,1.00,'wait',NULL,NULL,'Waiting for the rest / dashboard "partial"'),
('LSJP202602','60% ARRIVED',     3,'half','none','none',false,1.00,'split',NULL,NULL,'Send early, fee quoted but not charged'),
('LSKR202602','80% ARRIVED',     3,'half','none','none',false,1.00,'split',NULL,NULL,'Send early, fee charged / pay before it goes'),
('LSCN202602','50% ARRIVED',     3,'half','none','one', false,1.00,'hold',NULL,NULL,'Hold part of a half-landed trip'),
('LSJP202603','100% ARRIVED',    2,'full','none','all', false,1.00,'hold',NULL,NULL,'Hold everything, all of it landed'),
('LSCN202603','100% ARRIVED',    2,'full','none','none',false,1.00,'wait','GABUNG-1',NULL,'Paired, both sides ready'),
('LSJP202604','100% ARRIVED',    2,'full','none','none',false,1.00,'wait','GABUNG-1',NULL,'Paired, both sides ready'),
('LSKR202604','40% ARRIVED',     1,'half','none','none',false,1.00,'wait','GABUNG-2',NULL,'Paired but half-landed / mixed-timing warning'),
('LSCN202604','100% ARRIVED',    1,'full','none','none',false,1.00,'wait','GABUNG-2',NULL,'Paired with a trip that is still landing'),
('LSJP202605','ETA MID SEPTEMBER',0,'none','none','none',false,1.00,'wait',NULL,
   'Kos Melati 3B, Jl. Dipatiukur 22, Bandung','Nothing landed yet, going to a temporary address');

-- ── which shops each trip visited ───────────────────────────────────
-- Country decides the pool; the trip's position in the list decides which
-- three shops of that pool it actually visited. That is what keeps a search
-- for "muji" from matching every trip you have ever made.
CREATE TEMP TABLE seed_pool (country text, store text, product_id int) ON COMMIT DROP;
INSERT INTO seed_pool VALUES
  ('JP','MUJI',4447),('JP','MUJI',4448),('JP','MUJI',4449),('JP','MUJI',4450),('JP','MUJI',4451),
  ('JP','UNIQLO',4452),('JP','UNIQLO',4453),('JP','UNIQLO',4454),
  ('JP','NISHIMATSUYA',4455),('JP','NISHIMATSUYA',4456),('JP','NISHIMATSUYA',4457),
  ('JP','AKACHAN',4458),('JP','AKACHAN',4459),
  ('JP','DAISO',4460),('JP','DAISO',4461),
  ('JP','ANELLO',4462),
  ('KR','SKINFOOD',4463),('KR','INNISFREE',4464),('KR','LANEIGE',4465),
  ('KR','OLIVE YOUNG',4466),('KR','KAKAO',4467),
  ('CN','STANLEY',4468),('CN','XIAOMI',4469),('CN','MINISO',4470),('CN','CHARLES & KEITH',4471);

-- ── clear the previous history ──────────────────────────────────────
-- Scoped to this customer. Her rows on a trip shared with eleven other
-- customers are hers to delete; the trip itself is not.
DELETE FROM customer_shipping_prefs WHERE customer_id = (SELECT customer_id FROM seed_ctx);
DELETE FROM catalogue_requests      WHERE customer_id = (SELECT customer_id FROM seed_ctx);
DELETE FROM announcements           WHERE customer_id = (SELECT customer_id FROM seed_ctx);
DELETE FROM shipments   WHERE lower(replace(customer, '@', '')) = 'fandrianr';
DELETE FROM payments    WHERE lower(replace(customer, '@', '')) = 'fandrianr';
DELETE FROM adjustments WHERE lower(replace(customer, '@', '')) = 'fandrianr';
DELETE FROM orders      WHERE lower(replace(customer, '@', '')) = 'fandrianr';

-- The DEMO_ trips existed only to fake this history, so they go with it.
DELETE FROM events WHERE name LIKE 'DEMO\_%';
DELETE FROM events WHERE name IN (SELECT name FROM seed_events);

-- ── the trips ───────────────────────────────────────────────────────
INSERT INTO events (name, eta, warehouse_id, country_id, created_at, is_active)
SELECT e.name, e.eta, c.warehouse_id,
       CASE substring(e.name from 3 for 2)
         WHEN 'JP' THEN 2 WHEN 'KR' THEN 4 ELSE 1 END,
       NOW() - (e.months_ago || ' months')::interval,
       -- Only the recent trips are still open on the dashboard's event filter.
       e.months_ago <= 4
  FROM seed_events e CROSS JOIN seed_ctx c;

INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
SELECT customer_id, warehouse_id, rate FROM seed_ctx
ON CONFLICT (customer_id, warehouse_id) DO UPDATE SET ongkos_kirim = EXCLUDED.ongkos_kirim;

-- ── the lines ───────────────────────────────────────────────────────
WITH trip AS (
  SELECT e.*,
         substring(e.name from 3 for 2) AS country,
         (row_number() OVER (ORDER BY e.months_ago DESC, e.name) - 1)::int AS idx
    FROM seed_events e
), shop AS (
  SELECT country, store,
         (dense_rank() OVER (PARTITION BY country ORDER BY store) - 1)::int AS sidx,
         count(*) OVER (PARTITION BY country)::int AS shops
    FROM (SELECT DISTINCT country, store FROM seed_pool) d
), visited AS (
  -- Three shops per trip, rotating with the trip's position: consecutive trips
  -- to the same country overlap by two shops, the way repeat buying does,
  -- without every trip carrying the whole catalogue.
  SELECT t.name, t.idx, s.store
    FROM trip t
    JOIN shop s ON s.country = t.country
   WHERE ((s.sidx - t.idx) % s.shops + s.shops) % s.shops < 3
), line AS (
  SELECT v.name, p.product_id, v.idx,
         -- One to three of each, varied per trip so no two baskets are twins.
         ((p.product_id + v.idx) % 3 + 1)::int AS unit,
         row_number() OVER (PARTITION BY v.name ORDER BY p.product_id) AS rn,
         count(*)    OVER (PARTITION BY v.name)                        AS lines
    FROM visited v
    JOIN seed_pool p ON p.store = v.store AND p.country = substring(v.name from 3 for 2)
)
INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive, unit_ship, unit_hold, created_at)
SELECT l.name, c.handle, l.product_id, pr.price, l.unit,
       -- arrived
       CASE t.arrive
         WHEN 'full' THEN l.unit
         WHEN 'half' THEN CASE WHEN l.rn <= ceil(l.lines / 2.0) THEN l.unit ELSE 0 END
         ELSE 0 END,
       -- shipped
       CASE t.ship
         WHEN 'full' THEN l.unit
         WHEN 'half' THEN CASE WHEN l.rn <= floor(l.lines / 2.0) THEN l.unit ELSE 0 END
         ELSE 0 END,
       -- held: always a line that has actually landed, or the hold would be an
       -- instruction about units nobody has.
       CASE t.hold
         WHEN 'all' THEN CASE WHEN t.arrive = 'full' OR l.rn <= ceil(l.lines / 2.0) THEN l.unit ELSE 0 END
         WHEN 'one' THEN CASE WHEN l.rn = 1 THEN l.unit ELSE 0 END
         ELSE 0 END,
       NOW() - (t.months_ago || ' months')::interval
  FROM line l
  JOIN trip t ON t.name = l.name
  JOIN products pr ON pr.id = l.product_id
  CROSS JOIN seed_ctx c;

-- ── parcels that have already gone ──────────────────────────────────
-- shipping_id is numeric on purpose: the next-resi generator casts it to an
-- integer, and a row like 'SHIP-2601' makes every future ship press fail.
INSERT INTO shipments (event, customer, shipping_id, tracking_number, ongkir, ongkir_total,
                       weight_estimation, is_last_shipment, created_at)
SELECT t.name, c.handle,
       (2700 + row_number() OVER (ORDER BY t.months_ago DESC, t.name))::text,
       'JP' || lpad((90000000 + row_number() OVER (ORDER BY t.months_ago DESC, t.name))::text, 10, '0'),
       c.rate,
       (c.rate * GREATEST(1, ceil(SUM(pr.gram * o.unit_ship) / 1000.0)))::int,
       ROUND(SUM(pr.gram * o.unit_ship) / 1000.0, 2),
       t.ship = 'full',
       NOW() - (t.months_ago || ' months')::interval + interval '9 days'
  FROM seed_events t
  JOIN orders o ON o.event = t.name AND o.customer = (SELECT handle FROM seed_ctx)
  JOIN products pr ON pr.id = o.product_id
  CROSS JOIN seed_ctx c
 WHERE t.resi
 GROUP BY t.name, t.months_ago, t.ship, c.handle, c.rate;

-- ── money owed before money paid ────────────────────────────────────
-- Adjustments come first because they are part of the total the payment is a
-- fraction of. The one exception is the send-early fee below, which is charged
-- AFTER she has settled — that is the whole point of it.
INSERT INTO adjustments (event, customer, amount, description, created_at)
SELECT 'LSJP202512', handle, -15000, 'Diskon gabung ongkir', NOW() - interval '5 months'
  FROM seed_ctx;

INSERT INTO payments (event, customer, amount, is_checked, kind, pay_date, created_at)
SELECT i.name, c.handle, ROUND(i.total * i.pay), true, 'deposit',
       (NOW() - (i.months_ago || ' months')::interval)::date,
       NOW() - (i.months_ago || ' months')::interval
  FROM (
    SELECT t.name, t.pay, t.months_ago,
           SUM(o.unit_price * o.unit)
             + (SELECT rate FROM seed_ctx) * ceil(SUM(pr.gram * o.unit) / 1000.0)
             + COALESCE((SELECT SUM(a.amount) FROM adjustments a
                          WHERE a.event = t.name
                            AND lower(replace(a.customer, '@', '')) = 'fandrianr'), 0) AS total
      FROM seed_events t
      JOIN orders o ON o.event = t.name AND o.customer = (SELECT handle FROM seed_ctx)
      JOIN products pr ON pr.id = o.product_id
     GROUP BY t.name, t.pay, t.months_ago
  ) i CROSS JOIN seed_ctx c
 WHERE i.pay > 0;

-- Charged after settlement, so the balance goes short again and the pay-first
-- gate holds the parcel. There is no separate flag for "already billed" — this
-- adjustment IS the record, which is why its wording has to match the code.
INSERT INTO adjustments (event, customer, amount, description, created_at)
SELECT 'LSKR202602', handle, 15000, 'Ongkir kirim duluan', NOW() - interval '3 months' + interval '2 days'
  FROM seed_ctx;

-- ── what she asked the shop to do with each parcel ──────────────────
INSERT INTO customer_shipping_prefs (customer_id, event, mode, merge_key, temp_address,
                                     temp_area_id, temp_area_name, updated_at)
SELECT c.customer_id, t.name, t.mode, t.merge_key, t.temp_address,
       CASE WHEN t.temp_address IS NOT NULL THEN 'IDNP6IDNC148IDND897IDZ40132' END,
       CASE WHEN t.temp_address IS NOT NULL THEN 'Coblong, Bandung, Jawa Barat. 40132' END,
       NOW() - (t.months_ago || ' months')::interval + interval '3 days'
  FROM seed_events t CROSS JOIN seed_ctx c
 WHERE t.mode IS NOT NULL;

-- ── every request status, one of each ───────────────────────────────
-- 'asking' is the shop's own state: the request arrived by WhatsApp without
-- enough to identify the product, and staff are still asking which one. It is
-- the only status allowed to carry neither a product nor a description.
INSERT INTO catalogue_requests
  (customer_handle, customer_id, product_id, description, qty, note, status, staff_note,
   country_id, valas, gram, estimated_price, source, sender, created_at)
SELECT c.handle, c.customer_id, r.product_id, r.description, r.qty, r.note, r.status,
       r.staff_note, r.country_id, r.valas, r.gram, r.estimated_price, r.source, r.sender,
       NOW() - (r.days_ago || ' days')::interval
  FROM seed_ctx c
  CROSS JOIN (VALUES
    (4465, '', 2, 'Yang 70ml ya kak, bukan yang travel size',
     'pending', '', 4, NULL::numeric, NULL::numeric, NULL::int, 'catalogue', '', 2),
    (NULL, 'Muji Wall Shelf Oak 88cm', 1, 'Kalau ada yang oak, kalau tidak ada walnut juga tidak apa-apa',
     'offer_pending', 'Stok ada di Muji Ginza, harga sudah termasuk ongkir dalam negeri Jepang',
     2, 12800, 3200, 1985000, 'catalogue', '', 5),
    (4462, '', 1, 'Warna navy',
     'approved', 'Bisa dibawa di trip Jepang Oktober', 2, NULL, NULL, 620000, 'catalogue', '', 9),
    (NULL, '', 1, '', 'asking', 'Fotonya tidak jelas, sudah ditanya varian mana',
     NULL, NULL, NULL, NULL, 'whatsapp', '628121234567', 12),
    (4468, '', 1, 'Yang rose quartz',
     'converted', 'Masuk LSCN202604', 1, NULL, NULL, 585000, 'catalogue', '', 21),
    (NULL, 'Kakao Friends Apeach Plush 60cm', 1, 'Yang besar, buat kado',
     'rejected', 'Maaf kak, yang 60cm sudah discontinued sejak tahun lalu',
     4, NULL, NULL, NULL, 'catalogue', '', 30)
  ) AS r(product_id, description, qty, note, status, staff_note,
         country_id, valas, gram, estimated_price, source, sender, days_ago);

COMMIT;

-- ── what was built ──────────────────────────────────────────────────
\echo ''
\echo 'Trips, newest first:'
SELECT o.event,
       count(*)                       AS lines,
       SUM(o.unit)                    AS units,
       SUM(o.unit_arrive)             AS arrived,
       SUM(o.unit_ship)               AS shipped,
       SUM(COALESCE(o.unit_hold, 0))  AS held,
       COALESCE(p.mode, '-')          AS mode,
       COALESCE(p.merge_key, '')      AS pair,
       CASE WHEN EXISTS (SELECT 1 FROM shipments s WHERE s.event = o.event
                          AND lower(replace(s.customer,'@','')) = 'fandrianr'
                          AND s.tracking_number <> '') THEN 'resi' ELSE '' END AS resi
  FROM orders o
  LEFT JOIN customer_shipping_prefs p
    ON p.event = o.event AND p.customer_id = (SELECT id FROM customers WHERE instagram_id = 'fandrianr')
  JOIN events e ON e.name = o.event
 WHERE lower(replace(o.customer, '@', '')) = 'fandrianr'
 GROUP BY o.event, p.mode, p.merge_key, e.created_at
 ORDER BY e.created_at DESC;
