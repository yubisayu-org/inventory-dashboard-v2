import postgres from "postgres"
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { withActor } from "./actor"
import { appendOrders } from "./orders"
import { normalizeId } from "./helpers"
import type { CatalogueRequest } from "./types"
import { calcAbroadPrice } from "../pricing"
import { getCountryRate } from "./catalog"

function toRequest(r: Record<string, unknown>): CatalogueRequest {
  return {
    id: r.id as number,
    customerHandle: r.customer_handle as string,
    productId: (r.product_id as number | null) ?? null,
    productName: (r.product_name as string | null) ?? null,
    description: r.description as string,
    referenceImageUrl: (r.reference_image_url as string | null) ?? null,
    qty: r.qty as number,
    note: r.note as string,
    status: r.status as CatalogueRequest["status"],
    staffNote: r.staff_note as string,
    convertedOrderId: (r.converted_order_id as number | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
    countryId: (r.country_id as number | null) ?? null,
    countryName: (r.country_name as string | null) ?? null,
    // valas/gram are NUMERIC — postgres-js returns them as strings when
    // set, same coercion needed as everywhere else NUMERIC is read.
    valas: r.valas != null ? Number(r.valas) : null,
    gram: r.gram != null ? Number(r.gram) : null,
    estimatedPrice: (r.estimated_price as number | null) ?? null,
    postId: (r.post_id as number | null) ?? null,
    defaultEvent: (r.default_event as string | null) ?? null,
  }
}

/** Public path: submit one request — either a Fix request (productId set,
 *  description/referenceImageUrl omitted) or a custom request (productId
 *  null, description required — enforced by the DB check constraint, not
 *  re-validated here since the calling route already validates it).
 *  `db` must be the scoped `catalogue_public` connection — no default.
 *  Stores the handle normalized (bare lowercase, no "@"), matching every
 *  other customer handle write in this codebase. */
export async function createCatalogueRequest(
  data: {
    customerHandle: string
    productId: number | null
    qty: number
    note: string
    description?: string
    referenceImageUrl?: string | null
    postId?: number | null
  },
  db: postgres.Sql,
): Promise<void> {
  await db`
    INSERT INTO catalogue_requests (customer_handle, product_id, qty, note, description, reference_image_url, post_id)
    VALUES (
      ${normalizeId(data.customerHandle)},
      ${data.productId},
      ${data.qty},
      ${data.note},
      ${data.description ?? ""},
      ${data.referenceImageUrl ?? null},
      ${data.postId ?? null}
    )
  `
}

/** Public path: a handle's own requests. `db` must be the scoped
 *  `catalogue_public` connection — no default. LEFT JOIN (not JOIN) because
 *  a custom request has no product row to join to. */
export async function getCatalogueRequestsByHandle(
  handle: string,
  db: postgres.Sql,
): Promise<CatalogueRequest[]> {
  const rows = await db`
    SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
           r.description, r.reference_image_url,
           r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at,
           r.country_id, c.name AS country_name, r.valas, r.gram, r.estimated_price
    FROM catalogue_requests r
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN countries c ON c.id = r.country_id
    WHERE lower(replace(r.customer_handle, '@', '')) = ${normalizeId(handle)}
    ORDER BY r.created_at DESC
  `
  return rows.map(toRequest)
}

/** Staff path. LEFT JOIN for the same reason as above. */
export async function getCatalogueRequests(
  onlyPending: boolean,
  db: DBExecutor = sql,
): Promise<CatalogueRequest[]> {
  const rows = onlyPending
    ? await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.description, r.reference_image_url,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at,
               r.country_id, c.name AS country_name, r.valas, r.gram, r.estimated_price,
               r.post_id, h.default_event
        FROM catalogue_requests r
        LEFT JOIN products p ON p.id = r.product_id
        LEFT JOIN countries c ON c.id = r.country_id
        LEFT JOIN catalogue_posts cp ON cp.id = r.post_id
        LEFT JOIN catalogue_highlights h ON h.id = cp.highlight_id
        WHERE r.status IN ('pending', 'offer_pending', 'approved')
        ORDER BY r.created_at ASC
      `
    : await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.description, r.reference_image_url,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at,
               r.country_id, c.name AS country_name, r.valas, r.gram, r.estimated_price,
               r.post_id, h.default_event
        FROM catalogue_requests r
        LEFT JOIN products p ON p.id = r.product_id
        LEFT JOIN countries c ON c.id = r.country_id
        LEFT JOIN catalogue_posts cp ON cp.id = r.post_id
        LEFT JOIN catalogue_highlights h ON h.id = cp.highlight_id
        ORDER BY r.created_at DESC
      `
  return rows.map(toRequest)
}

/** Converts one request into a real order. A Fix request already carries
 *  its product_id; a custom request (product_id null) requires the caller
 *  to supply productIdOverride — staff picks a real product in the Convert
 *  modal before this is called. Both cases resolve to one final productId,
 *  then snapshot that product's current price (same convention as every
 *  other order-creation path), same as before this change.
 *
 *  Race protection unchanged: the initial SELECT locks the row (`FOR
 *  UPDATE`) and the final UPDATE re-checks `status IN ('pending',
 *  'approved')`, so two
 *  concurrent conversions of the same request can't both create an order —
 *  the loser's SELECT blocks until the winner commits, then sees the
 *  already-flipped status and gets zero rows, throwing before any order is
 *  created. The SELECT no longer JOINs products (product_id may be null),
 *  so the lock now covers exactly one table — simpler, not weaker. */
export async function convertCatalogueRequest(
  id: number,
  event: string,
  actor: string | null,
  productIdOverride?: number,
): Promise<{ orderId: number }> {
  return withActor(actor, async (tx) => {
    const [request] = await tx`
      SELECT customer_handle, product_id, qty, note
      FROM catalogue_requests
      WHERE id = ${id} AND status IN ('pending', 'approved')
      FOR UPDATE
    `
    if (!request) throw new Error("Request not found or already handled")

    const resolvedProductId = (request.product_id as number | null) ?? productIdOverride ?? null
    if (resolvedProductId === null) {
      throw new Error("A product must be selected to convert a custom request")
    }

    const [product] = await tx`SELECT price FROM products WHERE id = ${resolvedProductId}`
    if (!product) throw new Error("Selected product not found")

    const [created] = await appendOrders(
      [{
        event,
        customer: request.customer_handle as string,
        productId: resolvedProductId,
        unitPrice: product.price as number,
        unit: request.qty as number,
        note: request.note as string,
      }],
      tx,
    )

    const rows = await tx`
      UPDATE catalogue_requests
      SET status = 'converted', converted_order_id = ${created.id}, updated_at = NOW()
      WHERE id = ${id} AND status IN ('pending', 'approved')
      RETURNING id
    `
    if (rows.length === 0) throw new Error("Request not found or already handled")
    return { orderId: created.id }
  })
}

export async function rejectCatalogueRequest(
  id: number,
  staffNote: string,
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET status = 'rejected', staff_note = ${staffNote}, updated_at = NOW()
    WHERE id = ${id} AND status IN ('pending', 'approved')
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}

const EDIT_PROFIT_PCT = 15
const EDIT_ROUND_TO = 1000

/** Owner-only: propose a country/valas/gram revision on a pending custom
 *  request. Computes estimated_price server-side from the country's real
 *  kurs/cargoPerKg — fixed 15% margin, no fees, flat roundTo = 1000 (NOT
 *  the public estimator's relative-precision rounding; see this plan's
 *  Global Constraints for why that distinction matters here). Guarded:
 *  only from 'pending', moves to 'offer_pending'. Re-editing while already
 *  offer_pending is NOT allowed here — the UI's two-step cancel-edit →
 *  edit path handles that, since allowing it directly here would let a
 *  concurrent revision land on a row the customer just approved under a
 *  different (unseen) price. */
export async function editCatalogueRequest(
  id: number,
  data: { countryId: number; valas: number; gram: number },
  db: DBExecutor = sql,
): Promise<{ estimatedPrice: number }> {
  const rate = await getCountryRate(data.countryId, db)
  if (!rate) throw new Error("Country not found")

  const { price } = calcAbroadPrice({
    valas: data.valas,
    kurs: rate.kurs,
    gram: data.gram,
    cargoPerKg: rate.cargoPerKg,
    profitPct: EDIT_PROFIT_PCT,
    operationalFee: 0,
    packingFee: 0,
    roundTo: EDIT_ROUND_TO,
  })

  const rows = await db`
    UPDATE catalogue_requests
    SET country_id = ${data.countryId}, valas = ${data.valas}, gram = ${data.gram},
        estimated_price = ${price}, status = 'offer_pending', updated_at = NOW()
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
  return { estimatedPrice: price }
}

/** Owner-only: withdraw a proposed revision that hasn't been answered yet
 *  (e.g. a typo) without asking the customer to reject it. Clears the four
 *  offer columns and returns to 'pending'. */
export async function cancelEditCatalogueRequest(
  id: number,
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET country_id = NULL, valas = NULL, gram = NULL, estimated_price = NULL,
        status = 'pending', updated_at = NOW()
    WHERE id = ${id} AND status = 'offer_pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}

/** Public path: customer approves a revised offer. `db` must be the
 *  scoped `catalogue_public` connection (has UPDATE(status) only, per
 *  migration 079 — this function never sets any other column). Guarded on
 *  both the id AND the handle, so one customer can't approve/reject
 *  another's offer by guessing an id — the handle is exactly as visible
 *  to the customer as the id is (both come back from the same status
 *  lookup response), so this isn't a stronger trust boundary than the
 *  rest of this feature already relies on. */
export async function approveCatalogueRequestOffer(
  id: number,
  customerHandle: string,
  db: postgres.Sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET status = 'approved', updated_at = NOW()
    WHERE id = ${id}
      AND lower(replace(customer_handle, '@', '')) = ${normalizeId(customerHandle)}
      AND status = 'offer_pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}

/** Public path: customer rejects a revised offer — terminal, same as a
 *  staff reject. */
export async function rejectCatalogueRequestOffer(
  id: number,
  customerHandle: string,
  db: postgres.Sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET status = 'rejected', updated_at = NOW()
    WHERE id = ${id}
      AND lower(replace(customer_handle, '@', '')) = ${normalizeId(customerHandle)}
      AND status = 'offer_pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}

/** Owner-only: reopen a rejected request back to pending — the recovery
 *  path for a mistaken or forced customer reject, since nothing else in
 *  this file accepts 'rejected' as a starting status. */
export async function reopenCatalogueRequest(
  id: number,
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET status = 'pending', updated_at = NOW()
    WHERE id = ${id} AND status = 'rejected'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}
