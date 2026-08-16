import postgres from "postgres"
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { withActor } from "./actor"
import { appendOrders } from "./orders"
import { normalizeId } from "./helpers"
import type { CatalogueRequest } from "./types"

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
  },
  db: postgres.Sql,
): Promise<void> {
  await db`
    INSERT INTO catalogue_requests (customer_handle, product_id, qty, note, description, reference_image_url)
    VALUES (
      ${normalizeId(data.customerHandle)},
      ${data.productId},
      ${data.qty},
      ${data.note},
      ${data.description ?? ""},
      ${data.referenceImageUrl ?? null}
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
           r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at
    FROM catalogue_requests r
    LEFT JOIN products p ON p.id = r.product_id
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
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at
        FROM catalogue_requests r
        LEFT JOIN products p ON p.id = r.product_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at ASC
      `
    : await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.description, r.reference_image_url,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at
        FROM catalogue_requests r
        LEFT JOIN products p ON p.id = r.product_id
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
 *  UPDATE`) and the final UPDATE re-checks `status = 'pending'`, so two
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
      WHERE id = ${id} AND status = 'pending'
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
      WHERE id = ${id} AND status = 'pending'
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
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}
