-- Link event columns in orders, excess_purchase, and shipments to events.name.
-- Uses ON UPDATE CASCADE so renaming an event propagates automatically.
-- Uses ON DELETE RESTRICT so you can't delete an event that still has data.

-- First, backfill any missing events from existing data
INSERT INTO events (name)
  SELECT DISTINCT event FROM orders
  WHERE event NOT IN (SELECT name FROM events)
ON CONFLICT (name) DO NOTHING;

INSERT INTO events (name)
  SELECT DISTINCT event FROM excess_purchase
  WHERE event NOT IN (SELECT name FROM events)
ON CONFLICT (name) DO NOTHING;

INSERT INTO events (name)
  SELECT DISTINCT event FROM shipments
  WHERE event NOT IN (SELECT name FROM events)
ON CONFLICT (name) DO NOTHING;

-- Now add the foreign key constraints
ALTER TABLE orders
  ADD CONSTRAINT fk_orders_event
  FOREIGN KEY (event) REFERENCES events(name)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE excess_purchase
  ADD CONSTRAINT fk_excess_purchase_event
  FOREIGN KEY (event) REFERENCES events(name)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE shipments
  ADD CONSTRAINT fk_shipments_event
  FOREIGN KEY (event) REFERENCES events(name)
  ON UPDATE CASCADE ON DELETE RESTRICT;
