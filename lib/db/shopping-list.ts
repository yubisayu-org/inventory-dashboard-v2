import sql from "../db-pool"
import { allocateFifo } from "../fifo-fill"

// ─── Shopping List ────────────────────────────────────────────────────────

export type PaidStatus = "paid" | "partial" | "unpaid"

export interface ShoppingListOrder {
  id: number
  customer: string
  unit: number       // original ordered qty
  unitBuy: number    // already bought (0 if none)
  pending: number    // unit - unitBuy
  // Whether the customer has settled this event's invoice. Mirrors the same
  // math as computeEventCore: paid >= subtotal + ongkir*weight + adjustments.
  paidStatus: PaidStatus
}

export interface ShoppingListItem {
  event: string
  productId: number
  productName: string
  store: string
  totalUnits: number      // remaining to buy
  totalOriginal: number   // full ordered qty (for partial-state display)
  customerCount: number
  customers: string[]
  orderIds: number[]
  orders: ShoppingListOrder[]
}

export async function getShoppingList(event?: string): Promise<ShoppingListItem[]> {
  // Includes partially-bought orders (unit_buy < unit), not just untouched ones.
  // Aggregations expose both the remaining-to-buy quantity and the full ordered
  // quantity so the UI can show "5 / 10" when an order is partially fulfilled.
  const rows = event
    ? await sql`
        SELECT
          o.event,
          o.product_id,
          p.name AS product_name,
          p.store,
          SUM(o.unit - COALESCE(o.unit_buy, 0))::int AS total_pending,
          SUM(o.unit)::int AS total_original,
          COUNT(DISTINCT o.customer)::int AS customer_count,
          ARRAY_AGG(DISTINCT o.customer ORDER BY o.customer) AS customers,
          ARRAY_AGG(o.id ORDER BY o.id) AS order_ids,
          JSON_AGG(JSON_BUILD_OBJECT(
            'id', o.id,
            'customer', o.customer,
            'unit', o.unit,
            'unitBuy', COALESCE(o.unit_buy, 0),
            'pending', o.unit - COALESCE(o.unit_buy, 0)
          ) ORDER BY o.customer, o.id) AS orders
        FROM orders o
        JOIN products p ON p.id = o.product_id
        WHERE (o.unit_buy IS NULL OR o.unit_buy < o.unit) AND o.event = ${event}
        GROUP BY o.event, o.product_id, p.name, p.store
        HAVING SUM(o.unit - COALESCE(o.unit_buy, 0)) > 0
        ORDER BY p.name, p.store
      `
    : await sql`
        SELECT
          o.event,
          o.product_id,
          p.name AS product_name,
          p.store,
          SUM(o.unit - COALESCE(o.unit_buy, 0))::int AS total_pending,
          SUM(o.unit)::int AS total_original,
          COUNT(DISTINCT o.customer)::int AS customer_count,
          ARRAY_AGG(DISTINCT o.customer ORDER BY o.customer) AS customers,
          ARRAY_AGG(o.id ORDER BY o.id) AS order_ids,
          JSON_AGG(JSON_BUILD_OBJECT(
            'id', o.id,
            'customer', o.customer,
            'unit', o.unit,
            'unitBuy', COALESCE(o.unit_buy, 0),
            'pending', o.unit - COALESCE(o.unit_buy, 0)
          ) ORDER BY o.customer, o.id) AS orders
        FROM orders o
        JOIN products p ON p.id = o.product_id
        WHERE o.unit_buy IS NULL OR o.unit_buy < o.unit
        GROUP BY o.event, o.product_id, p.name, p.store
        HAVING SUM(o.unit - COALESCE(o.unit_buy, 0)) > 0
        ORDER BY o.event, p.name, p.store
      `

  const items: ShoppingListItem[] = rows.map((r) => ({
    event: r.event as string,
    productId: r.product_id as number,
    productName: r.product_name as string,
    store: r.store as string,
    totalUnits: r.total_pending as number,
    totalOriginal: r.total_original as number,
    customerCount: r.customer_count as number,
    customers: r.customers as string[],
    orderIds: r.order_ids as number[],
    // SQL emits raw JSON without paidStatus — filled in below from a second
    // query that runs the invoice math for each (event, customer) pair.
    orders: (r.orders as Omit<ShoppingListOrder, "paidStatus">[]).map((o) => ({
      ...o,
      paidStatus: "unpaid" as PaidStatus,
    })),
  }))

  if (items.length === 0) return items

  const events = [...new Set(items.map((i) => i.event))]
  const statusMap = await fetchPaidStatusMap(events)
  for (const item of items) {
    for (const o of item.orders) {
      o.paidStatus = statusMap.get(`${item.event}|${o.customer}`) ?? "unpaid"
    }
  }
  return items
}

/**
 * Compute paid status per (event, customer) for the given events. Mirrors
 * `computeEventCore` from invoice.ts:
 *   total = subtotal + ongkir_per_kg * ceil(total_gram / 1000) + adjustments
 *   paid  = sum of checked payments
 *   status = paid <= 0 ? unpaid : paid >= total ? paid : partial
 *
 * The customer column is stored with inconsistent casing/@-prefix across
 * tables, so payments/adjustments/customers are joined on the normalized
 * handle (lower + strip @), matching how invoice.ts does it.
 */
async function fetchPaidStatusMap(events: string[]): Promise<Map<string, PaidStatus>> {
  const map = new Map<string, PaidStatus>()
  if (events.length === 0) return map

  const rows = await sql`
    WITH order_totals AS (
      SELECT
        o.event,
        o.customer,
        lower(replace(o.customer, '@', '')) AS norm_cust,
        SUM(o.unit * o.unit_price)::numeric        AS subtotal,
        SUM(o.unit * COALESCE(p.gram, 0))::numeric AS total_gram
      FROM orders o
      JOIN products p ON p.id = o.product_id
      WHERE o.event = ANY(${events})
      GROUP BY o.event, o.customer
    ),
    payment_totals AS (
      SELECT
        event,
        lower(replace(customer, '@', '')) AS norm_cust,
        COALESCE(SUM(amount), 0)::numeric AS paid
      FROM payments
      WHERE is_checked = true AND event = ANY(${events})
      GROUP BY event, norm_cust
    ),
    adjustment_totals AS (
      SELECT
        event,
        lower(replace(customer, '@', '')) AS norm_cust,
        COALESCE(SUM(amount), 0)::numeric AS adj
      FROM adjustments
      WHERE event = ANY(${events})
      GROUP BY event, norm_cust
    ),
    customer_ongkir AS (
      SELECT
        lower(replace(instagram_id, '@', '')) AS norm_id,
        COALESCE(ongkos_kirim, 0)::numeric AS ongkir
      FROM customers
    )
    SELECT
      ot.event,
      ot.customer,
      ot.subtotal,
      CEIL(ot.total_gram / 1000.0)::numeric AS weight_kg,
      COALESCE(co.ongkir, 0)::numeric AS ongkir,
      COALESCE(at.adj, 0)::numeric    AS adj,
      COALESCE(pt.paid, 0)::numeric   AS paid
    FROM order_totals ot
    LEFT JOIN customer_ongkir co  ON co.norm_id = ot.norm_cust
    LEFT JOIN payment_totals pt   ON pt.event = ot.event AND pt.norm_cust = ot.norm_cust
    LEFT JOIN adjustment_totals at ON at.event = ot.event AND at.norm_cust = ot.norm_cust
  `

  for (const r of rows) {
    const subtotal = Number(r.subtotal) || 0
    const weightKg = Number(r.weight_kg) || 0
    const ongkir   = Number(r.ongkir) || 0
    const adj      = Number(r.adj) || 0
    const paid     = Number(r.paid) || 0
    const total    = subtotal + weightKg * ongkir + adj
    const status: PaidStatus = paid <= 0 ? "unpaid" : paid >= total ? "paid" : "partial"
    map.set(`${r.event}|${r.customer}`, status)
  }
  return map
}

export async function markOrdersAsBought(orderIds: number[]): Promise<void> {
  if (orderIds.length === 0) return
  await sql`
    UPDATE orders
    SET unit_buy = unit, updated_at = NOW()
    WHERE id = ANY(${orderIds}) AND unit_buy IS NULL
  `
}

export async function markProductBought(data: {
  event: string
  productId: number
  productName: string
  quantityBought: number
  receipt: string
}): Promise<{ filledOrderIds: number[]; excessUnits: number }> {
  // Partial allocation lets an order have unit_buy < unit, so it stays in the
  // shopping list with reduced "remaining" qty. Mirrors /api/sheets/purchasing.
  type Row = { id: number; unit: number; unitBuy: number; receipt: string; pending: number }
  const orders = (await sql`
    SELECT
      id,
      unit::int AS unit,
      COALESCE(unit_buy, 0)::int AS "unitBuy",
      COALESCE(receipt, '') AS receipt,
      (unit - COALESCE(unit_buy, 0))::int AS pending
    FROM orders
    WHERE event = ${data.event}
      AND product_id = ${data.productId}
      AND (unit_buy IS NULL OR unit_buy < unit)
    ORDER BY id ASC
  `) as unknown as Row[]

  const { allocations, excess: excessUnits } = allocateFifo(orders, (o) => o.pending, data.quantityBought)
  const filledOrderIds: number[] = []

  await sql.begin(async (tx) => {
    for (const { item: o, allocated } of allocations) {
      const newUnitBuy = o.unitBuy + allocated
      const combinedReceipt = data.receipt
        ? (o.receipt ? `${o.receipt}, ${data.receipt}` : data.receipt)
        : o.receipt
      if (newUnitBuy >= o.unit) filledOrderIds.push(o.id)
      await tx`
        UPDATE orders
        SET unit_buy = ${newUnitBuy}, receipt = ${combinedReceipt}, updated_at = NOW()
        WHERE id = ${o.id}
      `
    }
    if (excessUnits > 0) {
      await tx`
        INSERT INTO excess_purchase (event, items, unit_buy, receipt)
        VALUES (${data.event}, ${data.productName}, ${excessUnits}, ${data.receipt})
      `
    }
  })

  return { filledOrderIds, excessUnits }
}

