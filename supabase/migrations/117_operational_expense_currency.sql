-- What currency an expense was actually paid in.
--
-- The column never existed: the currency picked when adding an expense was
-- used to compute the rupiah amount and then thrown away, and the edit screen
-- guessed it back from `rate = 1 → IDR, otherwise the event's country`. With no
-- event there is nothing to guess from, so a USD expense with no event opened
-- as "FX" — and rate is a ratio, so USD and CNY are indistinguishable after
-- the fact.
--
-- NULL means a legacy row whose currency was never recorded. Those keep the
-- old inference; there is nothing to backfill them with, because the
-- information was not kept.
ALTER TABLE operational_expenses ADD COLUMN currency TEXT;

COMMENT ON COLUMN operational_expenses.currency IS
  'Currency the expense was paid in. NULL on rows added before it was stored.';

-- Rows paid in rupiah are the one case the old rule got right without an
-- event: a rate of exactly 1 means no conversion happened.
UPDATE operational_expenses SET currency = 'IDR' WHERE rate = 1 AND currency IS NULL;
