-- Link customer columns in orders and shipments to customers.instagram_id.
-- First normalizes all customer identifiers to a consistent format (lowercase with @ prefix).

-- Step 1: Normalize orders.customer and shipments.customer first (no unique constraint to conflict)
UPDATE orders
SET customer = lower(
  CASE WHEN customer NOT LIKE '@%' THEN '@' || customer ELSE customer END
)
WHERE customer != lower(
  CASE WHEN customer NOT LIKE '@%' THEN '@' || customer ELSE customer END
);

UPDATE shipments
SET customer = lower(
  CASE WHEN customer NOT LIKE '@%' THEN '@' || customer ELSE customer END
)
WHERE customer != lower(
  CASE WHEN customer NOT LIKE '@%' THEN '@' || customer ELSE customer END
);

-- Step 2: Merge duplicate customers that normalize to the same value.
-- Keep the row with the most data (longest data_diri), merge non-empty fields from others.
-- First, update the "winner" row with data from duplicates where the winner has empty fields.
UPDATE customers AS winner
SET
  whatsapp     = COALESCE(NULLIF(winner.whatsapp, ''),     (SELECT d.whatsapp     FROM customers d WHERE d.id != winner.id AND lower(replace(d.instagram_id, '@', '')) = lower(replace(winner.instagram_id, '@', '')) AND d.whatsapp     != '' LIMIT 1), winner.whatsapp),
  data_diri    = COALESCE(NULLIF(winner.data_diri, ''),    (SELECT d.data_diri    FROM customers d WHERE d.id != winner.id AND lower(replace(d.instagram_id, '@', '')) = lower(replace(winner.instagram_id, '@', '')) AND d.data_diri    != '' LIMIT 1), winner.data_diri),
  ekspedisi    = COALESCE(NULLIF(winner.ekspedisi, ''),    (SELECT d.ekspedisi    FROM customers d WHERE d.id != winner.id AND lower(replace(d.instagram_id, '@', '')) = lower(replace(winner.instagram_id, '@', '')) AND d.ekspedisi    != '' LIMIT 1), winner.ekspedisi),
  ongkos_kirim = CASE WHEN winner.ongkos_kirim = 0 THEN COALESCE((SELECT d.ongkos_kirim FROM customers d WHERE d.id != winner.id AND lower(replace(d.instagram_id, '@', '')) = lower(replace(winner.instagram_id, '@', '')) AND d.ongkos_kirim != 0 LIMIT 1), 0) ELSE winner.ongkos_kirim END
WHERE winner.id IN (
  -- Select the "winner" for each duplicate group: the one with the longest data_diri
  SELECT DISTINCT ON (lower(replace(instagram_id, '@', '')))
    id
  FROM customers
  ORDER BY lower(replace(instagram_id, '@', '')), length(data_diri) DESC, id
)
AND EXISTS (
  SELECT 1 FROM customers d
  WHERE d.id != winner.id
  AND lower(replace(d.instagram_id, '@', '')) = lower(replace(winner.instagram_id, '@', ''))
);

-- Delete the duplicate (non-winner) rows
DELETE FROM customers
WHERE id NOT IN (
  SELECT DISTINCT ON (lower(replace(instagram_id, '@', '')))
    id
  FROM customers
  ORDER BY lower(replace(instagram_id, '@', '')), length(data_diri) DESC, id
);

-- Step 3: Now safely normalize customers.instagram_id (no duplicates remain)
UPDATE customers
SET instagram_id = lower(
  CASE WHEN instagram_id NOT LIKE '@%' THEN '@' || instagram_id ELSE instagram_id END
)
WHERE instagram_id != lower(
  CASE WHEN instagram_id NOT LIKE '@%' THEN '@' || instagram_id ELSE instagram_id END
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
