-- Custom request edit & customer-approval flow (see
-- docs/superpowers/specs/2026-08-17-custom-request-edit-approval-design.md).
-- Owner can revise a pending custom request's country/valas/gram, which
-- re-estimates a price and requires the customer to approve it before the
-- owner can convert. Four new nullable columns carry the proposed/approved
-- offer; no history table, re-editing overwrites them in place.

ALTER TABLE catalogue_requests
  ADD COLUMN country_id INTEGER REFERENCES countries(id) ON DELETE SET NULL,
  ADD COLUMN valas NUMERIC,
  ADD COLUMN gram NUMERIC,
  ADD COLUMN estimated_price INTEGER;

ALTER TABLE catalogue_requests DROP CONSTRAINT catalogue_requests_status_check;
ALTER TABLE catalogue_requests ADD CONSTRAINT catalogue_requests_status_check
  CHECK (status IN ('pending', 'offer_pending', 'approved', 'converted', 'rejected'));

-- catalogue_public already has SELECT on a fixed column list (migration 058)
-- and INSERT (migration 059) on this table for the public submit/status-lookup
-- routes. Extend the SELECT list to the four new columns — the two new public
-- routes (approve/reject) need to read status for their guard, and the
-- existing public status-lookup GET needs to surface the offer to the
-- customer. Idempotent regardless of prior grant state, same discipline as
-- migration 063.
REVOKE SELECT ON catalogue_requests FROM catalogue_public;
GRANT SELECT (
  id, customer_handle, product_id, description, reference_image_url,
  qty, note, status, staff_note, converted_order_id, created_at,
  country_id, valas, gram, estimated_price
) ON catalogue_requests TO catalogue_public;

-- New: the public approve/reject routes need to flip status themselves.
-- Scoped to exactly that one column — every other write path (create) stays
-- INSERT-only, and the app-level guarded UPDATE (WHERE status =
-- 'offer_pending' AND customer_handle = ...) is what actually enforces which
-- transition is legal, not the grant alone.
GRANT UPDATE (status, updated_at) ON catalogue_requests TO catalogue_public;
