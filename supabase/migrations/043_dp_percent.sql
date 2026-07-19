-- Adds business_profile.dp_percent — the global "% of invoice total that
-- must be paid before the default invoice message is sent" threshold. Below
-- threshold, getInvoiceForCustomer sends the new invoice_dp template instead
-- (see lib/db/invoice.ts, lib/message-templates.ts).
--
-- DEFAULT 0 means every event's paid-so-far (always >= 0) already meets a
-- 0% threshold, so this column ships inert: no existing invoice message
-- changes until the owner sets a real percentage in Settings.
--
-- The 040_settings.sql audit trigger on business_profile already covers new
-- columns on that table (row-level trigger), same as 042_public_site_url.sql.

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS dp_percent NUMERIC(6,2) NOT NULL DEFAULT 0;
