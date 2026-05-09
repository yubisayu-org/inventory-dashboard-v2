-- Handle duplicate products with same (name, store).
-- Instead of merging/deleting, append a suffix to duplicate names so we can
-- add a UNIQUE constraint. The duplicates can be cleaned up manually later.
--
-- For each (name, store) group, the row with the lowest id keeps its original
-- name. All other rows get " (dup-N)" appended, where N is their position
-- in the group (ordered by id).

-- Step 1: Rename duplicates (keep lowest id unchanged)
UPDATE products AS p
SET name = p.name || ' (dup-' || sub.rn || ')'
FROM (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY name, store ORDER BY id) AS rn
  FROM products
  WHERE name != ''
) sub
WHERE sub.id = p.id
  AND sub.rn > 1;

-- Step 2: Add unique constraint (now safe — no duplicates remain)
ALTER TABLE products ADD CONSTRAINT uq_products_name_store UNIQUE (name, store);
