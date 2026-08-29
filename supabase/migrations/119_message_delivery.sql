-- How each kind of message reaches the customer.
--
-- Every message screen offered the same two buttons: Copy, for pasting into an
-- Instagram DM, and WhatsApp, for opening her chat. Which one gets pressed is
-- not a per-message decision -- it is how the shop talks to people, and it
-- differs by KIND: an invoice goes to the DM she ordered in, a refund goes to
-- WhatsApp where her bank details are. Two buttons on every screen made that
-- standing choice again, dozens of times a week.
--
-- One JSONB column rather than a column per kind: a fourth kind of message is a
-- line of TypeScript, not a migration. Unknown keys and missing keys both fall
-- back to "copy", which is what every screen did before this existed.
ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS message_delivery JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN business_profile.message_delivery IS
  'Per message kind: "copy" | "whatsapp". Missing or unknown means copy.';
