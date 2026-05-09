-- Merge all products with identical (name, store).
-- For exact duplicates (same price): delete extras, keep lowest id.
-- For same name+store with different prices: keep the highest price (latest procurement),
-- delete the rest.

-- Step 1: For each (name, store) group with duplicates, update the winner to have the highest price
UPDATE products AS winner
SET price = (
  SELECT MAX(d.price)
  FROM products d
  WHERE d.name = winner.name AND d.store = winner.store
)
WHERE id IN (
  SELECT MIN(id) FROM products
  WHERE name != ''
  GROUP BY name, store
  HAVING COUNT(*) > 1
);

-- Step 2: Delete all duplicate rows (keep the lowest id per name+store)
DELETE FROM products
WHERE id NOT IN (
  SELECT MIN(id) FROM products GROUP BY name, store
)
AND name != '';

-- Step 3: Add unique constraint
ALTER TABLE products ADD CONSTRAINT uq_products_name_store UNIQUE (name, store);
