-- Who put this payment row here.
--
-- Needed so a duplicate warning can say the true thing. "She reported this
-- herself on 3 Sep, still waiting to be checked" invites one action — tick
-- hers — while "#4789 already records this" invites another. Without the
-- column both cases read the same, and the reader has to guess which they are
-- looking at.
--
-- 'shop' is the default because that is what every row was until the
-- catalogue learnt to file claims.

ALTER TABLE payments
  ADD COLUMN reported_by text NOT NULL DEFAULT 'shop'
  CHECK (reported_by IN ('shop', 'customer'));

-- The rows already filed from the catalogue, recovered from the audit trail:
-- staff and owner writes carry an actor, and catalogue_public sets none, so an
-- INSERT with no actor is a customer's own claim. Seven rows in production at
-- the time of writing.
UPDATE payments p
   SET reported_by = 'customer'
  FROM audit.audit_log a
 WHERE a.table_name = 'payments'
   AND a.action = 'INSERT'
   AND a.row_id = p.id::text
   AND coalesce(nullif(a.actor, ''), '') = '';

-- The catalogue writes it on the way in, and reads it back so her own sheet
-- can tell her which of her claims is which.
GRANT INSERT (reported_by), SELECT (reported_by) ON payments TO catalogue_public;
