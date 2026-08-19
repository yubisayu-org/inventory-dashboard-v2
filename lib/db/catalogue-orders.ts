import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { normalizeId } from "./helpers"

// A signed-in customer's own purchase history and balance.
//
// Scoped by handle from the verified session. orders.customer is a FK to
// customers.instagram_id, and both carry a normalised index, so the join is
// the same one the staff screens use.

export type CustomerOrder = {
  id: number
  event: string
  productName: string
  qty: number
  unitPrice: number
  total: number
  note: string
  createdAt: string
  /** Where it has got to, derived from the per-stage quantities. */
  stage: "ordered" | "bought" | "arrived" | "shipped" | "dispatched"
  /** Fully progressed through the stage above, rather than partially. */
  stageComplete: boolean
  receipt: string
  dispatchReceipt: string
}

export type CustomerBalance = {
  invoiceCount: number
  totalInvoiced: number
  totalOutstanding: number
}

/**
 * The furthest stage this order has actually reached.
 *
 * Read from the largest stage with any quantity rather than a status column,
 * because that is how the data is shaped — a partially shipped order has
 * unit_ship below unit, and saying "shipped" without saying "3 of 5" would be
 * a half-truth.
 */
function stageOf(row: {
  unit: number
  unit_buy: number | null
  unit_arrive: number | null
  unit_ship: number | null
  unit_dispatch: number | null
}): { stage: CustomerOrder["stage"]; stageComplete: boolean } {
  const stages: [CustomerOrder["stage"], number][] = [
    ["dispatched", row.unit_dispatch ?? 0],
    ["shipped", row.unit_ship ?? 0],
    ["arrived", row.unit_arrive ?? 0],
    ["bought", row.unit_buy ?? 0],
  ]
  for (const [stage, qty] of stages) {
    if (qty > 0) return { stage, stageComplete: qty >= row.unit }
  }
  return { stage: "ordered", stageComplete: true }
}

export async function getCustomerOrders(
  instagramId: string,
  db: DBExecutor = sql,
): Promise<CustomerOrder[]> {
  const key = normalizeId(instagramId)
  const rows = await db<
    {
      id: number
      event: string
      product_name: string
      unit: number
      unit_price: number
      note: string
      created_at: Date
      receipt: string
      dispatch_receipt: string
      unit_buy: number | null
      unit_arrive: number | null
      unit_ship: number | null
      unit_dispatch: number | null
    }[]
  >`
    SELECT o.id, o.event, p.name AS product_name, o.unit, o.unit_price, o.note,
           o.created_at, o.receipt, o.dispatch_receipt,
           o.unit_buy, o.unit_arrive, o.unit_ship, o.unit_dispatch
      FROM orders o
      JOIN products p ON p.id = o.product_id
     WHERE lower(replace(o.customer, '@', '')) = ${key}
     ORDER BY o.created_at DESC
  `
  return rows.map((r) => {
    const { stage, stageComplete } = stageOf(r)
    return {
      id: r.id,
      event: r.event,
      productName: r.product_name,
      qty: r.unit,
      unitPrice: r.unit_price,
      total: r.unit_price * r.unit,
      note: r.note,
      createdAt: r.created_at.toISOString(),
      stage,
      stageComplete,
      receipt: r.receipt,
      dispatchReceipt: r.dispatch_receipt,
    }
  })
}

/**
 * What this customer has been invoiced and what is still outstanding.
 *
 * Read from customer_invoice_summary, which aggregates orders, payments,
 * adjustments and ongkir into three numbers — so the public role reaches a
 * balance without payments or adjustments being readable at all.
 */
export async function getCustomerBalance(
  instagramId: string,
  db: DBExecutor = sql,
): Promise<CustomerBalance> {
  const key = normalizeId(instagramId)
  const [row] = await db<
    { invoice_count: string; total_invoiced: string; total_outstanding: string }[]
  >`
    SELECT invoice_count, total_invoiced, total_outstanding
      FROM customer_invoice_summary WHERE cust_key = ${key}
  `
  // A customer with no invoices has no row, which is a zero balance rather
  // than an error.
  return {
    invoiceCount: Number(row?.invoice_count ?? 0),
    totalInvoiced: Number(row?.total_invoiced ?? 0),
    totalOutstanding: Number(row?.total_outstanding ?? 0),
  }
}
