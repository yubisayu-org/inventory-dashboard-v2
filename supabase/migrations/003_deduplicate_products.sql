-- Merge products with identical (name, store) and add unique constraint.
-- Keeps the row with the lowest id (oldest), takes the highest price from duplicates.

-- Step 1: For each duplicate group, update the winner with the best price
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

-- Step 2: Delete duplicate rows (keep the lowest id per name+store)
DELETE FROM products
WHERE id NOT IN (
  SELECT MIN(id) FROM products GROUP BY name, store
)
AND name != '';

-- Step 3: Add unique constraint so duplicates can't be re-created
ALTER TABLE products ADD CONSTRAINT uq_products_name_store UNIQUE (name, store);
