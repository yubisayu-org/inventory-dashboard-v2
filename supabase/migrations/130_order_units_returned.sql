-- Units she bought, received, and sent back.
--
-- A quality refund used to move money and nothing else: her invoice went on
-- billing the item, so paying the refund out — which writes a negative payment
-- — left her owing for goods sitting on the shop's own shelf. One customer is
-- in exactly that state today.
--
-- Cancelling a line was not the answer either. Those units really did ship, and
-- writing unit_ship down would make the Packing List offer them again while
-- the parcel's own record still said they left.
--
-- So the return is recorded where it happened, on the line, and every place
-- that turns units into money or weight bills `unit - unit_returned`. The line
-- keeps saying she bought five; the invoice charges for four; the courier's
-- record of a five-unit parcel stays true; and the ongkir those goods were
-- carrying comes back with them, the same way it does when a line is
-- cancelled.

ALTER TABLE orders
  ADD COLUMN unit_returned integer NOT NULL DEFAULT 0
  CHECK (unit_returned >= 0);

COMMENT ON COLUMN orders.unit_returned IS
  'Units returned by the customer after delivery. Billed units are unit - unit_returned; unit_ship and the shipment record are left alone, because the parcel really did carry them.';

-- Her own invoice on the catalogue reads the same columns the dashboard does,
-- and would otherwise keep billing her for what she sent back.
GRANT SELECT (unit_returned) ON orders TO catalogue_public;
GRANT SELECT (unit_returned) ON orders TO invoice_reader;
