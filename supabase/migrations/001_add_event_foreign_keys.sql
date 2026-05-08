-- Link event columns in orders, excess_purchase, and shipments to events.name.
-- Uses ON UPDATE CASCADE so renaming an event propagates automatically.
-- Uses ON DELETE RESTRICT so you can't delete an event that still has data.
--
-- Prerequisites: all event values in orders/excess_purchase/shipments must
-- already exist in the events table. Run the check queries below first:
--
--   SELECT DISTINCT event FROM orders WHERE event NOT IN (SELECT name FROM events);
--   SELECT DISTINCT event FROM excess_purchase WHERE event NOT IN (SELECT name FROM events);
--   SELECT DISTINCT event FROM shipments WHERE event NOT IN (SELECT name FROM events);
--
-- If any rows are returned, insert the missing events before running this migration:
--   INSERT INTO events (name) VALUES ('missing_event_name');

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
