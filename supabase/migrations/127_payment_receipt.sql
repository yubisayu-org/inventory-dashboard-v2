-- A photo of the transfer, when she wants to send one.
--
-- Optional on purpose. The shop reconciles from the bank's own mutasi by
-- amount and sender name, so a receipt proves nothing it did not already know
-- — but some customers want to show it, and telling them not to bother reads
-- as the shop not caring whether her money arrived.
--
-- '' rather than NULL: every other text column on this table is NOT NULL with
-- an empty default, and one nullable column among them is a special case for
-- every reader to remember.

ALTER TABLE payments
  ADD COLUMN receipt_url text NOT NULL DEFAULT '';

-- She uploads it from the catalogue, so that role writes the column; and it
-- reads it back so her own payment history can show what she attached.
GRANT INSERT (receipt_url), SELECT (receipt_url) ON payments TO catalogue_public;
