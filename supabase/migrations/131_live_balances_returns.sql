-- live_balances has to know about returns too.
--
-- The view is what the Refunds page prices an open overpayment from, and what
-- the trip-notice reminder decides "still owes" from. Left as it was, it would
-- keep counting goods the customer has sent back — so a returned item would
-- read as debt on one screen while the invoice beside it read zero.
--
-- ONLY the unit columns change. The ongkir column this view reads
-- (ongkos_kirim, where the invoice reads effective_ongkir) is a known
-- difference the owner has deliberately parked, and quietly "fixing" it here
-- would move money on refunds that are already open.

CREATE OR REPLACE VIEW live_balances AS
WITH order_aggregates AS (
  SELECT o.event AS event,
         lower(replace(o.customer, '@', '')) AS cust_key,
         -- Billed units: what she keeps. A return takes its own price and its
         -- own weight off the bill, exactly as it does on the invoice.
         SUM(o.unit_price * GREATEST(o.unit - COALESCE(o.unit_returned, 0), 0)) AS subtotal,
         SUM(COALESCE(p.gram, 0) * GREATEST(o.unit - COALESCE(o.unit_returned, 0), 0)) AS total_gram
    FROM orders o
    JOIN products p ON p.id = o.product_id
   GROUP BY 1, 2
),
payment_aggregates AS (
  SELECT event, lower(replace(customer, '@', '')) AS cust_key, SUM(amount) AS total_paid
    FROM payments
   WHERE is_checked = true
   GROUP BY 1, 2
),
adjustment_aggregates AS (
  SELECT event, lower(replace(customer, '@', '')) AS cust_key, SUM(amount) AS total_adj
    FROM adjustments
   GROUP BY 1, 2
),
customer_ongkir AS (
  SELECT ev.name AS event,
         lower(replace(c.instagram_id, '@', '')) AS cust_key,
         COALESCE(cwo.ongkos_kirim, 0) AS ongkos_kirim
    FROM events ev
    JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
    JOIN customers c ON c.id = cwo.customer_id
)
SELECT oa.event,
       oa.cust_key AS customer,
       (oa.subtotal
         + COALESCE(co.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
         + COALESCE(adj.total_adj, 0))::int AS invoice_total,
       COALESCE(pa.total_paid, 0)::int AS total_paid,
       (COALESCE(pa.total_paid, 0)
         - (oa.subtotal
            + COALESCE(co.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
            + COALESCE(adj.total_adj, 0)))::int AS balance
  FROM order_aggregates oa
  LEFT JOIN payment_aggregates pa ON pa.event = oa.event AND pa.cust_key = oa.cust_key
  LEFT JOIN adjustment_aggregates adj ON adj.event = oa.event AND adj.cust_key = oa.cust_key
  LEFT JOIN customer_ongkir co ON co.event = oa.event AND co.cust_key = oa.cust_key;

COMMENT ON VIEW live_balances IS
  'Per (event, customer) invoice/paid/balance on normalized handles, billing unit - unit_returned. Read by open overpayment refunds.';
