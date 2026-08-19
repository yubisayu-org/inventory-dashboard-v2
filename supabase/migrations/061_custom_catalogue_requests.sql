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

-- Defensive reset: an earlier, pre-fix version of migration 059 (before a
-- later commit narrowed it) may have granted table-wide INSERT on this
-- table on some already-migrated databases (local dev included) — editing
-- that migration file afterward doesn't retroactively revoke what an
-- earlier apply already granted. This REVOKE + the two GRANTs below
-- restore the intended column-scoped-only state regardless of history.
REVOKE INSERT ON catalogue_requests FROM catalogue_public;
GRANT INSERT (customer_handle, product_id, qty, note) ON catalogue_requests TO catalogue_public;
GRANT INSERT (description, reference_image_url) ON catalogue_requests TO catalogue_public;
