-- The Shipping page shows each line's stages: ordered, ready, held, sent.
--
-- 100 column-scoped orders to exactly what getPublicInvoiceForCustomer read at
-- the time, deliberately fail-closed — reading a new column without granting
-- it raises a permission error rather than silently widening the public
-- endpoint. unit_hold is that new column, and it is a count of units, no more
-- private than unit_ship beside it.
--
-- Re-running is safe.

GRANT SELECT (unit_hold) ON orders TO invoice_reader;
