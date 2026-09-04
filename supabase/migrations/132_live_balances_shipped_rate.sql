-- live_balances prices delivery the way the invoice prices it.
--
-- The invoice takes the rate from the parcel that shipped — what the courier
-- actually charged — and falls back to the quote when nothing has gone yet
-- (see getInvoiceForCustomer). This view was written before that rule existed
-- and has been using the old imported price list for everything since.
--
-- The disagreement is not cosmetic: this view is what the Refunds page reads
-- to open overpayment refunds. Thirty customers show as having overpaid here
-- while their own invoices say they are settled, which makes every refund
-- suggestion on the page worth less than it should be.
--
-- A shipment recording ongkir = 0 is treated as "not recorded" rather than as
-- free delivery. Seven parcels are in that state, and reading them literally
-- would say those customers owe nothing for postage at all.
--
-- The ongkos_kirim → effective_ongkir difference this fixes is the tail of
-- migration 122, which switched the invoices to JNE's quotes and did not reach
-- here.

CREATE OR REPLACE VIEW live_balances AS
WITH order_aggregates AS (
  SELECT o.event AS event,
         lower(replace(o.customer, '@', '')) AS cust_key,
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
-- What the parcel was billed at, when one has gone out with a tracking number.
shipped_rate AS (
  SELECT DISTINCT ON (s.event, lower(replace(s.customer, '@', '')))
         s.event AS event,
         lower(replace(s.customer, '@', '')) AS cust_key,
         NULLIF(s.ongkir, 0) AS rate
    FROM shipments s
   WHERE s.tracking_number <> ''
   ORDER BY s.event, lower(replace(s.customer, '@', '')), s.id DESC
),
quoted_rate AS (
  SELECT ev.name AS event,
         lower(replace(c.instagram_id, '@', '')) AS cust_key,
         COALESCE(cwo.effective_ongkir, 0) AS rate
    FROM events ev
    JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
    JOIN customers c ON c.id = cwo.customer_id
),
priced AS (
  SELECT oa.event, oa.cust_key,
         (oa.subtotal
           + COALESCE(sr.rate, qr.rate, 0) * CEIL(oa.total_gram::numeric / 1000)
           + COALESCE(adj.total_adj, 0))::int AS invoice_total,
         COALESCE(pa.total_paid, 0)::int AS total_paid
    FROM order_aggregates oa
    LEFT JOIN payment_aggregates pa ON pa.event = oa.event AND pa.cust_key = oa.cust_key
    LEFT JOIN adjustment_aggregates adj ON adj.event = oa.event AND adj.cust_key = oa.cust_key
    LEFT JOIN shipped_rate sr ON sr.event = oa.event AND sr.cust_key = oa.cust_key
    LEFT JOIN quoted_rate qr ON qr.event = oa.event AND qr.cust_key = oa.cust_key
)
SELECT event, cust_key AS customer, invoice_total, total_paid,
       (total_paid - invoice_total) AS balance
  FROM priced;

COMMENT ON VIEW live_balances IS
  'Per (event, customer) invoice/paid/balance, priced the way the invoice prices it: the shipped parcel''s own rate, else the quote. Billed units are unit - unit_returned.';
