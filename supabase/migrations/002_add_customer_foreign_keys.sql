-- Link customer columns in orders and shipments to customers.instagram_id.
-- First normalizes all customer identifiers to a consistent format (lowercase with @ prefix).

-- Step 1: Normalize customers.instagram_id
UPDATE customers
SET instagram_id = lower(
  CASE WHEN instagram_id NOT LIKE '@%' THEN '@' || instagram_id ELSE instagram_id END
)
WHERE instagram_id != lower(
  CASE WHEN instagram_id NOT LIKE '@%' THEN '@' || instagram_id ELSE instagram_id END
);

-- Step 2: Normalize orders.customer to match
UPDATE orders
SET customer = lower(
  CASE WHEN customer NOT LIKE '@%' THEN '@' || customer ELSE customer END
)
WHERE customer != lower(
  CASE WHEN customer NOT LIKE '@%' THEN '@' || customer ELSE customer END
);

-- Step 3: Normalize shipments.customer to match
UPDATE shipments
SET customer = lower(
  CASE WHEN customer NOT LIKE '@%' THEN '@' || customer ELSE customer END
)
WHERE customer != lower(
  CASE WHEN customer NOT LIKE '@%' THEN '@' || customer ELSE customer END
);

-- Step 4: Auto-create customer records for any that exist in orders/shipments but not in customers
INSERT INTO customers (instagram_id)
  SELECT DISTINCT customer FROM orders
  WHERE customer NOT IN (SELECT instagram_id FROM customers)
ON CONFLICT (instagram_id) DO NOTHING;

INSERT INTO customers (instagram_id)
  SELECT DISTINCT customer FROM shipments
  WHERE customer NOT IN (SELECT instagram_id FROM customers)
ON CONFLICT (instagram_id) DO NOTHING;

-- Step 5: Add foreign key constraints
ALTER TABLE orders
  ADD CONSTRAINT fk_orders_customer
  FOREIGN KEY (customer) REFERENCES customers(instagram_id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE shipments
  ADD CONSTRAINT fk_shipments_customer
  FOREIGN KEY (customer) REFERENCES customers(instagram_id)
  ON UPDATE CASCADE ON DELETE RESTRICT;
