-- Valas can be fractional (e.g. 0.38), change from INTEGER to NUMERIC.

ALTER TABLE products ALTER COLUMN valas TYPE NUMERIC(12,2) USING valas::NUMERIC(12,2);
