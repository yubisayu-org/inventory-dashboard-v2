-- Convert pay_date column from TEXT to DATE.
-- PREREQUISITE: Run `npx tsx scripts/convert-pay-dates.ts <year>` first
-- to convert existing "20-Jan" values to "2026-01-20" (or whichever year).

-- Step 1: Drop NOT NULL so empty strings can become NULL.
ALTER TABLE payments ALTER COLUMN pay_date DROP NOT NULL;
ALTER TABLE payments ALTER COLUMN pay_date DROP DEFAULT;

-- Step 2: Set empty strings to NULL.
UPDATE payments SET pay_date = NULL WHERE pay_date = '';

-- Step 3: Change column type to DATE.
ALTER TABLE payments
  ALTER COLUMN pay_date TYPE DATE USING pay_date::date,
  ALTER COLUMN pay_date SET DEFAULT NULL;
