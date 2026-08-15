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
    productId: r.product_id as number,
    productName: r.product_name as string,
    qty: r.qty as number,
    note: r.note as string,
    status: r.status as CatalogueRequest["status"],
    staffNote: r.staff_note as string,
    convertedOrderId: (r.converted_order_id as number | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
  }
}

/** Public path: submit one request. `db` must be the scoped
 *  `catalogue_public` connection — no default. Stores the handle
 *  normalized (bare lowercase, no "@"), matching every other customer
 *  handle write in this codebase. */
export async function createCatalogueRequest(
  data: { customerHandle: string; productId: number; qty: number; note: string },
  db: postgres.Sql,
): Promise<void> {
  await db`
    INSERT INTO catalogue_requests (customer_handle, product_id, qty, note)
    VALUES (${normalizeId(data.customerHandle)}, ${data.productId}, ${data.qty}, ${data.note})
  `
}

/** Public path: a handle's own requests. `db` must be the scoped
 *  `catalogue_public` connection — no default. */
export async function getCatalogueRequestsByHandle(
  handle: string,
  db: postgres.Sql,
): Promise<CatalogueRequest[]> {
  const rows = await db`
    SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
           r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at
    FROM catalogue_requests r
    JOIN products p ON p.id = r.product_id
    WHERE lower(replace(r.customer_handle, '@', '')) = ${normalizeId(handle)}
    ORDER BY r.created_at DESC
  `
  return rows.map(toRequest)
}

/** Staff path. */
export async function getCatalogueRequests(
  onlyPending: boolean,
  db: DBExecutor = sql,
): Promise<CatalogueRequest[]> {
  const rows = onlyPending
    ? await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at
        FROM catalogue_requests r
        JOIN products p ON p.id = r.product_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at ASC
      `
    : await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at
        FROM catalogue_requests r
        JOIN products p ON p.id = r.product_id
        ORDER BY r.created_at DESC
      `
  return rows.map(toRequest)
}

/** Converts one request into a real order — the request's product/qty/note
 *  become the order's, staff supplies the event (the one field a request
 *  never carries), and the order snapshots the product's current price
 *  (same convention as every other order-creation path). Calls the same
 *  appendOrders every other order goes through; both the order insert and
 *  the request's status flip happen in one transaction so they can't
 *  half-apply. The initial SELECT locks the row (`FOR UPDATE`) and the final
 *  UPDATE re-checks `status = 'pending'`, so two concurrent conversions of
 *  the same request can't both create an order — the loser's SELECT blocks
 *  until the winner commits, then sees the already-flipped status and gets
 *  zero rows, throwing before any order is created. */
export async function convertCatalogueRequest(
  id: number,
  event: string,
  actor: string | null,
): Promise<{ orderId: number }> {
  return withActor(actor, async (tx) => {
    const [request] = await tx`
      SELECT r.customer_handle, r.product_id, r.qty, r.note, p.price
      FROM catalogue_requests r
      JOIN products p ON p.id = r.product_id
      WHERE r.id = ${id} AND r.status = 'pending'
      FOR UPDATE OF r
    `
    if (!request) throw new Error("Request not found or already handled")

    const [created] = await appendOrders(
      [{
        event,
        customer: request.customer_handle as string,
        productId: request.product_id as number,
        unitPrice: (request.price as number) ?? 0,
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
