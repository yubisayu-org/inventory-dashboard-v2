-- QRIS as a second way for a customer to pay, alongside a bank transfer.
--
-- Three ceilings rather than one, because they do different jobs and a single
-- number cannot do all three. The per-payment cap keeps one scan small. The
-- per-order cap closes the hole the per-payment cap leaves: the amount field
-- is the customer's to edit, so without it she can put an entire order through
-- QRIS in several small scans and break no rule. The yearly cap is the one
-- that actually bounds the shop's QRIS turnover, which is what decides how the
-- acquirer classifies the merchant — and it counts what staff record by hand
-- as well, since that is the shop's volume just as much.
--
-- 0 means "no ceiling" on all three, which is also how the Settings box reads
-- an empty field. qris_enabled is left false: the QR image has to be uploaded
-- before there is anything to show a customer.

ALTER TABLE business_profile
  ADD COLUMN qris_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN qris_image_url text NOT NULL DEFAULT '',
  ADD COLUMN qris_merchant_name text NOT NULL DEFAULT '',
  ADD COLUMN qris_max_per_payment bigint NOT NULL DEFAULT 0,
  ADD COLUMN qris_max_per_order bigint NOT NULL DEFAULT 0,
  ADD COLUMN qris_max_per_year bigint NOT NULL DEFAULT 0;

-- The shop's chosen figures, so the box opens filled in rather than empty.
-- Every one of them is editable in Settings afterwards.
UPDATE business_profile
   SET qris_max_per_payment = 100000,
       qris_max_per_order   = 300000,
       qris_max_per_year    = 150000000
 WHERE id = 1;

-- catalogue_public reads business_profile column by column — it is granted the
-- bank details and nothing else. The customer's sheet needs to know whether
-- QRIS is offered, which QR to show, and the two ceilings it must respect
-- before it offers the button. The yearly one is granted because the check
-- against it runs on this role too — but its value never leaves the server:
-- how much the shop has taken this year is nobody's business but the shop's,
-- so the customer is told only that QRIS is closed, never how close to the
-- ceiling the year has come.
GRANT SELECT (qris_enabled, qris_image_url, qris_merchant_name,
              qris_max_per_payment, qris_max_per_order, qris_max_per_year)
  ON business_profile TO catalogue_public;
