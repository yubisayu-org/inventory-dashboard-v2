-- The customer can see money owed back to her, and say where it should go.
--
-- Reads only. Every write is a status transition — pending to "keep it on my
-- account", or to "here is my bank" — and a transition is a rule rather than a
-- column, so those run on the main pool inside lib/db/catalogue-refunds.ts
-- where the rule can be enforced. A grant cannot express "you may set this
-- status but not that one".
--
-- The columns below are what her own card shows. `receipt`-style internals are
-- absent, and so is anything about another customer: row scoping lives in the
-- query's WHERE clause, as everywhere else on this path, and these grants only
-- decide what could be reached if that clause were ever wrong.
--
-- bank_account_number is readable because she is reading back what she herself
-- typed — and the API masks it to the last four digits before it leaves the
-- server, so a borrowed phone shows nothing she did not already know.
--
-- Numbered 113, not 112: this and 112_dispatch_route_prefixes were written in
-- parallel and both landed on 112. The CLI keys its ledger by version, so two
-- files claiming one number means the second is recorded as applied without
-- ever running — the same trap 112_dispatch_route_prefixes had already dodged
-- once at 111. Neither had reached any database when this moved, so nothing
-- was applied under the old number and nothing needs backfilling.
--
-- Re-running is safe.

GRANT SELECT (id, event, customer, reason, refund_amount, status, note,
              bank_name, bank_account_number, bank_account_holder,
              transfer_reference, created_at)
  ON refunds TO catalogue_public;
