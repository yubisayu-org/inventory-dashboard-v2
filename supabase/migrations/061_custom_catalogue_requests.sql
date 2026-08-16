-- Extends catalogue_requests (migration 058) to support a "custom" request
-- that has no tagged catalogue product: a free-text description of what the
-- customer wants, with an optional reference photo, instead of a product_id.
-- See docs/superpowers/specs/2026-08-16-custom-order-requests-design.md.

ALTER TABLE catalogue_requests
  ALTER COLUMN product_id DROP NOT NULL,
  ADD COLUMN description TEXT NOT NULL DEFAULT '',
  ADD COLUMN reference_image_url TEXT;

-- A request must be one or the other: a tagged product, or a description of
-- what the customer wants. Never neither (an empty, meaningless row).
ALTER TABLE catalogue_requests
  ADD CONSTRAINT catalogue_requests_product_or_description
  CHECK (product_id IS NOT NULL OR description <> '');

-- Column-privilege GRANTs are additive in Postgres — this ADDS description
-- and reference_image_url to the INSERT column list migration 059 already
-- granted (customer_handle, product_id, qty, note); it does not need to
-- REVOKE and re-grant the existing columns.
GRANT INSERT (description, reference_image_url) ON catalogue_requests TO catalogue_public;
