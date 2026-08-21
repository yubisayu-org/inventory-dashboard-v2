-- The owner-decided product name for a custom request's price quotation
-- (formerly "Propose a price revision"), separate from the customer's own
-- free-text description: description stays what she originally typed, this
-- is what the owner renames the item to once she agrees a price — carried
-- forward to prefill Create Product & convert. Null until a quotation has
-- been made.
ALTER TABLE catalogue_requests
  ADD COLUMN proposed_name text;
