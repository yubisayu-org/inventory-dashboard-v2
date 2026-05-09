-- Convert pay_date column from TEXT to DATE.
-- PREREQUISITE: Run `npx tsx scripts/convert-pay-dates.ts <year>` first
-- to convert existing "20-Jan" values to "2026-01-20" (or whichever year).

-- Set empty strings to NULL before altering column type.
UPDATE payments
SET pay_date = NULL
WHERE pay_date = '';

-- Alter column type from TEXT to DATE.
ALTER TABLE payments
  ALTER COLUMN pay_date DROP DEFAULT,
  ALTER COLUMN pay_date DROP NOT NULL,
  ALTER COLUMN pay_date TYPE DATE USING pay_date::date,
  ALTER COLUMN pay_date SET DEFAULT NULL;
