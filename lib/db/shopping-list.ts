import sql from "../db-pool"
import { allocateFifo } from "../fifo-fill"

// ─── Shopping List ────────────────────────────────────────────────────────

export interface ShoppingListOrder {
  id: number
  customer: string
  unit: number       // original ordered qty
  unitBuy: number    // already bought (0 if none)
  pending: number    // unit - unitBuy
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

  return rows.map((r) => ({
    event: r.event as string,
    productId: r.product_id as number,
    productName: r.product_name as string,
    store: r.store as string,
    totalUnits: r.total_pending as number,
    totalOriginal: r.total_original as number,
    customerCount: r.customer_count as number,
    customers: r.customers as string[],
    orderIds: r.order_ids as number[],
    orders: r.orders as ShoppingListOrder[],
  }))
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

