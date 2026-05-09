-- Replace orders.items (text) with orders.product_id (FK) + orders.unit_price (snapshot).

-- Step 1: Add new columns
ALTER TABLE orders ADD COLUMN product_id INTEGER;
ALTER TABLE orders ADD COLUMN unit_price INTEGER NOT NULL DEFAULT 0;

-- Step 2: Create products for any order items that don't exist in the products table
INSERT INTO products (name, store, price)
SELECT DISTINCT o.items, '', 0
FROM orders o
LEFT JOIN products p ON p.name = o.items
WHERE p.id IS NULL AND o.items IS NOT NULL AND o.items != ''
ON CONFLICT (name, store) DO NOTHING;

-- Step 3: Backfill product_id and unit_price from products table.
-- For items that match multiple products (same name, different stores), pick the lowest id.
UPDATE orders o
SET product_id = sub.pid,
    unit_price = sub.pprice
FROM (
  SELECT DISTINCT ON (name) id AS pid, name, price AS pprice
  FROM products
  ORDER BY name, id
) sub
WHERE sub.name = o.items;

-- Step 4: Make product_id NOT NULL and add FK
ALTER TABLE orders ALTER COLUMN product_id SET NOT NULL;
ALTER TABLE orders ADD CONSTRAINT fk_orders_product
  FOREIGN KEY (product_id) REFERENCES products(id)
  ON DELETE RESTRICT;

-- Step 5: Replace the old index
DROP INDEX IF EXISTS idx_orders_event_items;
CREATE INDEX idx_orders_event_product ON orders (event, product_id);

-- Step 6: Drop the old items column
ALTER TABLE orders DROP COLUMN items;
