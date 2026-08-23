-- The customer tells the shop what she transferred, and the shop confirms it
-- against the bank's own record.
--
-- No new table: a payment she reports is an ordinary `payments` row that has
-- not been checked yet, which is the row the shop already creates when it
-- records a transfer it has not reconciled. Every field she fills already has
-- a column — amount, account (which of the shop's banks), remarks (the name on
-- her sending account) — and `is_checked` already governs whether a row counts
-- towards an invoice.
--
-- Two columns are new, and both exist for the answer being no. Without them a
-- refused claim has nowhere to go: it either sits unchecked in the shop's
-- queue for ever, or it is deleted and the customer is left watching a payment
-- that silently ceased to exist.
--
-- Re-running is safe.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS rejected_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reject_reason  TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN payments.rejected_at IS
  'Set when the shop could not confirm the payment. A rejected row never counts '
  'towards an invoice (is_checked stays false) and leaves the unchecked queue.';
COMMENT ON COLUMN payments.reject_reason IS
  'Why it was refused, in words the customer reads. Empty unless rejected_at is set.';

-- The unchecked queue is work, so a refused row must not sit in it.
CREATE INDEX IF NOT EXISTS idx_payments_unchecked_open
  ON payments (event, customer)
  WHERE is_checked = false AND rejected_at IS NULL;

-- ── catalogue_public ────────────────────────────────────────────────────────
-- She may write a claim and read her own back. The grant is column by column
-- and `is_checked` is deliberately NOT in it: the column default, false, is
-- then the only value a customer can produce, so no request can mark its own
-- payment as verified. `rejected_at` and `reject_reason` are likewise readable
-- and not writable — the refusal is the shop's word, not hers.
--
-- Row scoping lives in the query's WHERE clause, as everywhere else on this
-- path, and the handle comes from the verified session rather than the
-- request body. These grants only decide which COLUMNS could ever be reached
-- if that clause were wrong.
GRANT SELECT (id, event, customer, amount, account, remarks, is_checked,
              pay_date, kind, created_at, rejected_at, reject_reason)
  ON payments TO catalogue_public;

GRANT INSERT (event, customer, amount, account, remarks, pay_date, kind)
  ON payments TO catalogue_public;

GRANT USAGE, SELECT ON payments_id_seq TO catalogue_public;

-- The invoice she is shown is read on invoice_reader, which sums only checked
-- rows. It needs to see the refusal so a rejected claim cannot be presented as
-- money on its way.
GRANT SELECT (rejected_at, reject_reason) ON payments TO invoice_reader;

-- Where she is asked to send the money. Two columns only: the account holder
-- and the account lines, which the shop already publishes on its invoices.
-- Read from here rather than typed into the catalogue so the numbers she is
-- shown cannot drift from the ones the shop actually uses.
-- id is in the list because the query orders by it, and ORDER BY reads a
-- column just as surely as SELECT does.
GRANT SELECT (id, bank_account_holder, bank_account_lines)
  ON business_profile TO catalogue_public;
