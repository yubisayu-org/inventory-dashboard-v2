-- 038: live_balances view — single source of truth for the per-(event, customer)
-- invoice/payment formula.
--
-- Why: refund amounts used to be stored snapshots (refunds.refund_amount),
-- patched by a background reconciler that could only touch "pristine" rows
-- (no linked payments). Once credit was applied, the row froze and drifted
-- from the live invoice. The payments ledger already self-balances — every
-- money movement (deposit +, credit leg −, cash refund −) is a payment row —
-- so total_paid − invoice_total is ALWAYS the correct remaining refundable
-- amount. This view exposes that number so open overpayment refunds can be
-- displayed live instead of reconciled.
--
-- The formula mirrors the `live` CTE previously inlined in
-- materializeOverpaymentRefunds (lib/db/finance.ts) and the math in
-- getInvoiceForCustomer / getPaymentStatus:
--   invoice_total = orders subtotal
--                 + ongkir rate (event's warehouse) × CEIL(total grams / 1000)
--                 + adjustments
--   total_paid    = SUM(checked payments)  -- all kinds: deposit/credit/refund
--
-- Apply manually in the Supabase SQL editor as postgres.

CREATE OR REPLACE VIEW live_balances AS
WITH order_aggregates AS (
  SELECT
    o.event,
    o.customer,
    SUM(o.unit_price * o.unit) AS subtotal,
    SUM(COALESCE(p.gram, 0) * o.unit) AS total_gram
  FROM orders o
  JOIN products p ON p.id = o.product_id
  GROUP BY o.event, o.customer
),
payment_aggregates AS (
  SELECT event, customer, SUM(amount) AS total_paid
  FROM payments
  WHERE is_checked = true
  GROUP BY event, customer
),
adjustment_aggregates AS (
  SELECT event, customer, SUM(amount) AS total_adj
  FROM adjustments
  GROUP BY event, customer
)
SELECT
  oa.event,
  oa.customer,
  (oa.subtotal
    + COALESCE(cwo.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
    + COALESCE(adj.total_adj, 0))::int AS invoice_total,
  COALESCE(pa.total_paid, 0)::int AS total_paid,
  (COALESCE(pa.total_paid, 0)
    - (oa.subtotal
       + COALESCE(cwo.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
       + COALESCE(adj.total_adj, 0)))::int AS balance
FROM order_aggregates oa
LEFT JOIN customers c ON c.instagram_id = oa.customer
-- Ongkir is the rate from the event's warehouse (per-event routing).
LEFT JOIN events ev ON ev.name = oa.event
LEFT JOIN customer_warehouse_ongkir cwo
  ON cwo.customer_id = c.id AND cwo.warehouse_id = ev.warehouse_id
LEFT JOIN payment_aggregates pa ON pa.event = oa.event AND pa.customer = oa.customer
LEFT JOIN adjustment_aggregates adj ON adj.event = oa.event AND adj.customer = oa.customer;

GRANT SELECT ON live_balances TO app_runtime;
