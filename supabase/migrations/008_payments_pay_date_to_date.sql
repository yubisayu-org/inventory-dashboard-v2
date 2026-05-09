-- Convert pay_date from TEXT (e.g. "20-Jan", "5-Feb") to proper DATE type.
-- Existing values use {day}-{month_abbr} format; assume year 2026.

-- Step 1: Convert non-empty text values to dates using to_date().
-- "20-Jan" → to_date('20-Jan-2026', 'DD-Mon-YYYY') → 2026-01-20
UPDATE payments
SET pay_date = to_date(pay_date || '-2026', 'DD-Mon-YYYY')::text
WHERE pay_date != '';

-- Step 2: Set empty strings to NULL before altering column type.
UPDATE payments
SET pay_date = NULL
WHERE pay_date = '';

-- Step 3: Alter column type from TEXT to DATE.
ALTER TABLE payments
  ALTER COLUMN pay_date DROP DEFAULT,
  ALTER COLUMN pay_date DROP NOT NULL,
  ALTER COLUMN pay_date TYPE DATE USING pay_date::date,
  ALTER COLUMN pay_date SET DEFAULT NULL;
