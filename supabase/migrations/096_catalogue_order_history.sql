-- Order history for a signed-in customer: what they bought, where it is, and
-- what they still owe.
--
-- orders.customer is a FK to customers.instagram_id, so scoping is by handle
-- from the verified session. As everywhere else on this path, the row-level
-- scoping lives in the query's WHERE clause; these grants only decide which
-- COLUMNS could ever be reached if that clause were wrong.

-- unit_buy / unit_arrive / unit_ship / unit_hold / unit_dispatch are
-- quantities at each fulfilment stage, not money — they are what lets a
-- customer see "3 of 5 shipped" rather than a bare status word.
--
-- Not granted: nothing here is cost or margin, because orders holds neither.
-- Cost lives on products, whose grant stays (id, name, store, price).
GRANT SELECT (id, event, customer, product_id, unit_price, unit, note,
              created_at, receipt, unit_buy, unit_arrive, unit_ship,
              unit_hold, unit_dispatch, dispatch_receipt)
  ON orders TO catalogue_public;

-- The roll-up view aggregates orders, payments, adjustments and ongkir into
-- three numbers. Granting the VIEW rather than its underlying tables is the
-- point: the public role gets a customer's balance without payments or
-- adjustments becoming reachable at all.
GRANT SELECT ON customer_invoice_summary TO catalogue_public;
