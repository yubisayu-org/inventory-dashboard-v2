import sql from "../db-pool"
import { normalizeId, tsToString } from "./helpers"
import { allocateFifo } from "../fifo-fill"
import type { ShipOrderLine, ShipCustomer, ShipOrdersParams, ShippingRecord, CustomerDetail } from "./types"

// ─── Ship Orders ────────────────────────────────────────────────────────────

function buildSearchFilters(opts: { event?: string; search?: string }) {
  const conditions: string[] = []
  const params: (string | number)[] = []
  if (opts.event) {
    params.push(opts.event)
    conditions.push(`o.event = $${params.length}`)
  }
  if (opts.search) {
    params.push(`%${normalizeId(opts.search)}%`)
    conditions.push(`lower(replace(o.customer, '@', '')) LIKE $${params.length}`)
  }
  return { conditions, params }
}

function buildShipGroups(
  orderRows: Record<string, unknown>[],
  detailMap: Map<string, CustomerDetail>,
): ShipCustomer[] {
  const groupMap = new Map<string, { customer: string; event: string; rows: Record<string, unknown>[] }>()
  for (const row of orderRows) {
    const key = `${normalizeId(row.customer as string)}|${row.event}`
    if (!groupMap.has(key)) groupMap.set(key, { customer: row.customer as string, event: row.event as string, rows: [] })
    groupMap.get(key)!.rows.push(row)
  }

  return Array.from(groupMap.values()).map(({ customer, event, rows }) => {
    const customerKey = normalizeId(customer)
    const orders: ShipOrderLine[] = rows.map((r) => {
      const unitArrive = (r.unit_arrive as number) ?? 0
      const unitShip = (r.unit_ship as number) ?? 0
      return {
        rowNumber: r.id as number,
        event,
        items: `${r.product_name} x ${r.unit}`,
        productId: r.product_id as number,
        productName: r.product_name as string,
        gram: (r.gram as number) ?? 0,
        unit: r.unit as number,
        unitArrive,
        unitShip,
        toShip: Math.max(0, unitArrive - unitShip),
      }
    })
    const totalToShipGram = orders.reduce((s, o) => s + o.gram * o.toShip, 0)
    const ongkirPerKg = detailMap.get(customerKey)?.ongkosKirim ?? 0
    return {
      customer,
      event,
      customerDetail: detailMap.get(customerKey) ?? null,
      orders,
      totalToShip: orders.reduce((s, o) => s + o.toShip, 0),
      // Billed weight is rounded up to the next whole kg (courier-style),
      // matching how invoices compute ongkir.
      weightKg: Math.ceil(totalToShipGram / 1000),
      ongkirPerKg,
    }
  })
}

async function fetchCustomerDetails(customerIds: Set<string>): Promise<Map<string, CustomerDetail>> {
  const detailMap = new Map<string, CustomerDetail>()
  if (customerIds.size === 0) return detailMap
  const rows = await sql`
    SELECT instagram_id, whatsapp, data_diri, ekspedisi, ongkos_kirim
    FROM customers
    WHERE lower(replace(instagram_id, '@', '')) = ANY(${[...customerIds]})
  `
  for (const r of rows) {
    const id = normalizeId(r.instagram_id)
    if (id) {
      detailMap.set(id, {
        whatsapp: r.whatsapp ?? "",
        dataDiri: r.data_diri ?? "",
        ekspedisi: r.ekspedisi ?? "",
        ongkosKirim: r.ongkos_kirim ?? 0,
        bankName: r.bank_name ?? "",
        bankAccountNumber: r.bank_account_number ?? "",
        bankAccountHolder: r.bank_account_holder ?? "",
      })
    }
  }
  return detailMap
}

export type ShipSegment = "all" | "not_arrived" | "ready" | "shipped"

export interface ShipOrdersFiltered {
  groups: ShipCustomer[]
  totalCount: number
  counts: Record<ShipSegment, number>
}

export async function getShipOrdersFiltered(opts: {
  segment?: ShipSegment
  search?: string
  event?: string
}): Promise<ShipOrdersFiltered> {
  const { segment = "all", search, event } = opts

  const { conditions, params } = buildSearchFilters({ event, search })

  if (segment === "not_arrived") {
    conditions.push("(o.unit_arrive IS NULL OR o.unit_arrive = 0)")
  } else if (segment !== "all") {
    conditions.push("o.unit_arrive IS NOT NULL AND o.unit_arrive > 0")
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const { conditions: countConds, params: countParams } = buildSearchFilters({ event, search })
  const countWhere = countConds.length > 0 ? `WHERE ${countConds.join(" AND ")}` : ""

  const [orderRows, countRows] = await Promise.all([
    sql.unsafe(
      `SELECT o.id, o.event, o.customer, o.product_id, p.name AS product_name,
              COALESCE(p.gram, 0) AS gram, o.unit, o.unit_arrive, o.unit_ship
       FROM orders o
       JOIN products p ON p.id = o.product_id
       ${where}
       ORDER BY o.event, o.customer, o.id`,
      params,
    ),
    sql.unsafe(
      `SELECT
         o.customer, o.event,
         bool_and(COALESCE(o.unit_arrive, 0) = 0) AS all_not_arrived,
         COALESCE(SUM(GREATEST(0, COALESCE(o.unit_arrive, 0) - COALESCE(o.unit_ship, 0))), 0) AS total_to_ship
       FROM orders o ${countWhere}
       GROUP BY o.customer, o.event`,
      countParams,
    ),
  ])

  const customerIds = new Set<string>()
  for (const r of orderRows) customerIds.add(normalizeId(r.customer))

  const detailMap = await fetchCustomerDetails(customerIds)
  const allGroups = buildShipGroups(orderRows, detailMap)

  const filteredGroups = segment === "ready"
    ? allGroups.filter((g) => g.totalToShip > 0)
    : segment === "shipped"
      ? allGroups.filter((g) => g.totalToShip === 0)
      : allGroups

  let notArrivedCount = 0
  let readyCount = 0
  let shippedCount = 0
  for (const r of countRows) {
    if (r.all_not_arrived) notArrivedCount++
    else if (Number(r.total_to_ship) > 0) readyCount++
    else shippedCount++
  }

  return {
    groups: filteredGroups,
    totalCount: filteredGroups.length,
    counts: {
      all: notArrivedCount + readyCount + shippedCount,
      not_arrived: notArrivedCount,
      ready: readyCount,
      shipped: shippedCount,
    },
  }
}

export async function shipCustomerOrders(params: ShipOrdersParams): Promise<{ shippingId: string }> {
  const { customer, event, orders, weightKg, ongkirPerKg } = params

  return await sql.begin(async (tx) => {
    const [maxRow] = await tx`
      SELECT COALESCE(MAX(shipping_id::integer), 0) AS max_id FROM shipments
    `
    const shippingId = String((maxRow.max_id ?? 0) + 1).padStart(4, "0")

    const toShipRows = orders.filter((o) => o.toShip > 0)
    const invoicingText = toShipRows.map((o) => `${o.productName} x ${o.toShip}`).join("\n")
    // Bill ongkir per kg, rounded up to the next whole kg (courier-style).
    const billedKg = Math.ceil(weightKg)
    const ongkirTotal = ongkirPerKg * billedKg

    await tx`
      INSERT INTO shipments (event, customer, shipping_id, invoicing, weight_estimation, ongkir, ongkir_total, is_last_shipment)
      VALUES (${event}, ${customer}, ${shippingId}, ${invoicingText}, ${billedKg}, ${ongkirPerKg}, ${ongkirTotal}, true)
    `

    for (const order of toShipRows) {
      await tx`
        UPDATE orders
        SET unit_ship = COALESCE(unit_ship, 0) + ${order.toShip}, updated_at = NOW()
        WHERE id = ${order.rowNumber}
      `
    }

    return { shippingId }
  })
}

// ─── Shipments ──────────────────────────────────────────────────────────────

export async function getShippingRecords(): Promise<ShippingRecord[]> {
  const rows = await sql`
    SELECT id, event, customer, shipping_id, invoicing,
           weight_estimation, ongkir, ongkir_total, is_last_shipment,
           created_at, updated_at, tracking_number
    FROM shipments
    WHERE shipping_id != ''
    ORDER BY id ASC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    event: r.event,
    customer: r.customer,
    shippingId: String(r.shipping_id).padStart(4, "0"),
    invoicing: r.invoicing ?? "",
    weightEstimation: Number(r.weight_estimation) || 0,
    ongkir: r.ongkir ?? 0,
    ongkirTotal: r.ongkir_total ?? 0,
    isLastShipment: r.is_last_shipment ?? false,
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
    trackingNumber: r.tracking_number ?? "",
  }))
}

export async function updateTrackingNumber(
  rowNumber: number,
  trackingNumber: string,
): Promise<void> {
  await sql`
    UPDATE shipments
    SET tracking_number = ${trackingNumber}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

// ─── Arrival List ──────────────────────────────────────────────────────────

export interface ArrivalListOrder {
  id: number
  customer: string
  unitBuy: number
  unitArrive: number
  pending: number
}

export interface ArrivalListItem {
  event: string
  productId: number
  productName: string
  store: string
  totalPending: number   // remaining to arrive
  totalBought: number    // full quantity we bought (for partial-state display)
  customerCount: number
  customers: string[]
  orderIds: number[]
  orders: ArrivalListOrder[]
}

/**
 * Items that have been bought (unit_buy IS NOT NULL) but haven't fully arrived yet
 * (unit_arrive IS NULL OR unit_arrive < unit_buy). Grouped by event + product, with
 * the per-customer order list nested for the mark-arrived modal.
 */
export async function getArrivalList(event?: string): Promise<ArrivalListItem[]> {
  const rows = event
    ? await sql`
        SELECT
          o.event,
          o.product_id,
          p.name AS product_name,
          p.store,
          SUM(o.unit_buy - COALESCE(o.unit_arrive, 0))::int AS total_pending,
          SUM(o.unit_buy)::int AS total_bought,
          COUNT(DISTINCT o.customer)::int AS customer_count,
          ARRAY_AGG(DISTINCT o.customer ORDER BY o.customer) AS customers,
          ARRAY_AGG(o.id ORDER BY o.id) AS order_ids,
          JSON_AGG(JSON_BUILD_OBJECT(
            'id', o.id,
            'customer', o.customer,
            'unitBuy', o.unit_buy,
            'unitArrive', COALESCE(o.unit_arrive, 0),
            'pending', o.unit_buy - COALESCE(o.unit_arrive, 0)
          ) ORDER BY o.customer, o.id) AS orders
        FROM orders o
        JOIN products p ON p.id = o.product_id
        WHERE o.unit_buy IS NOT NULL
          AND (o.unit_arrive IS NULL OR o.unit_arrive < o.unit_buy)
          AND o.event = ${event}
        GROUP BY o.event, o.product_id, p.name, p.store
        HAVING SUM(o.unit_buy - COALESCE(o.unit_arrive, 0)) > 0
        ORDER BY p.name, p.store
      `
    : await sql`
        SELECT
          o.event,
          o.product_id,
          p.name AS product_name,
          p.store,
          SUM(o.unit_buy - COALESCE(o.unit_arrive, 0))::int AS total_pending,
          SUM(o.unit_buy)::int AS total_bought,
          COUNT(DISTINCT o.customer)::int AS customer_count,
          ARRAY_AGG(DISTINCT o.customer ORDER BY o.customer) AS customers,
          ARRAY_AGG(o.id ORDER BY o.id) AS order_ids,
          JSON_AGG(JSON_BUILD_OBJECT(
            'id', o.id,
            'customer', o.customer,
            'unitBuy', o.unit_buy,
            'unitArrive', COALESCE(o.unit_arrive, 0),
            'pending', o.unit_buy - COALESCE(o.unit_arrive, 0)
          ) ORDER BY o.customer, o.id) AS orders
        FROM orders o
        JOIN products p ON p.id = o.product_id
        WHERE o.unit_buy IS NOT NULL
          AND (o.unit_arrive IS NULL OR o.unit_arrive < o.unit_buy)
        GROUP BY o.event, o.product_id, p.name, p.store
        HAVING SUM(o.unit_buy - COALESCE(o.unit_arrive, 0)) > 0
        ORDER BY o.event, p.name, p.store
      `

  return rows.map((r) => ({
    event: r.event as string,
    productId: r.product_id as number,
    productName: r.product_name as string,
    store: r.store as string,
    totalPending: r.total_pending as number,
    totalBought: r.total_bought as number,
    customerCount: r.customer_count as number,
    customers: r.customers as string[],
    orderIds: r.order_ids as number[],
    orders: r.orders as ArrivalListOrder[],
  }))
}

/**
 * Partial allocation: shipments arrive in batches, so an order can have
 * unit_arrive < unit_buy and still appear in the arrival list with reduced
 * pending qty.
 */
export async function markProductArrived(data: {
  event: string
  productId: number
  quantityArrived: number
}): Promise<{ filledOrderIds: number[]; unassignedUnits: number }> {
  type Row = { id: number; unitBuy: number; unitArrive: number; pending: number }
  const orders = (await sql`
    SELECT
      id,
      unit_buy::int AS "unitBuy",
      COALESCE(unit_arrive, 0)::int AS "unitArrive",
      (unit_buy - COALESCE(unit_arrive, 0))::int AS pending
    FROM orders
    WHERE event = ${data.event}
      AND product_id = ${data.productId}
      AND unit_buy IS NOT NULL
      AND (unit_arrive IS NULL OR unit_arrive < unit_buy)
    ORDER BY id ASC
  `) as unknown as Row[]

  const { allocations, excess: unassignedUnits } = allocateFifo(orders, (o) => o.pending, data.quantityArrived)
  const filledOrderIds: number[] = []

  if (allocations.length > 0) {
    await sql.begin(async (tx) => {
      for (const { item: o, allocated } of allocations) {
        const newUnitArrive = o.unitArrive + allocated
        if (newUnitArrive >= o.unitBuy) filledOrderIds.push(o.id)
        await tx`
          UPDATE orders
          SET unit_arrive = ${newUnitArrive}, updated_at = NOW()
          WHERE id = ${o.id}
        `
      }
    })
  }

  return { filledOrderIds, unassignedUnits }
}

