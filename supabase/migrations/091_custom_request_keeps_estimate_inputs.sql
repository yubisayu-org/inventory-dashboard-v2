-- Let the public path store what the customer typed to get their estimate.
--
-- country_id, valas, gram and estimated_price already exist on
-- catalogue_requests (added with the staff propose-price flow), but the public
-- INSERT grant was column-scoped without them — so the customer filled in
-- weight, origin and price, saw an estimate, and none of it survived the
-- submit. Staff then re-entered numbers the customer had already given.
--
-- Column-scoped as before: status and staff_note remain unreachable, so a
-- caller still cannot pre-approve itself or write a staff note.
GRANT INSERT (country_id, valas, gram, estimated_price)
  ON catalogue_requests TO catalogue_public;
