import sql from "../db-pool"

// ─── Dashboard Summary ─────────────────────────────────────────────────────

export interface DashboardActionQueue {
  overpaymentCandidates: number
  refundsPending: number
  refundsAwaitingBankInfo: number
  refundsReadyToTransfer: number
  itemsPendingPurchase: number
  itemsPendingArrival: number
  customersReadyToShip: number
}

export interface DashboardEvent {
  name: string
  eta: string
  orderCount: number
  customerCount: number
  totalUnits: number
  totalSubtotal: number
  totalBought: number
  totalArrived: number
  totalShipped: number
  totalPaid: number
}

export interface DashboardSummary {
  actionQueue: DashboardActionQueue
  events: DashboardEvent[]
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const [
    overpaymentCount,
    refundCounts,
    pendingPurchaseCount,
    pendingArrivalCount,
    readyToShipCount,
    eventRows,
  ] = await Promise.all([
    sql`
      WITH order_aggregates AS (
        SELECT
          o.event,
          o.customer,
          SUM(o.unit_price * o.unit) AS subtotal,
          SUM(COALESCE(p.gram, 0) * o.unit) AS total_gram
        FROM orders o
        JOIN products p ON p.id = o.product_id
        GROUP BY o.event, o.customer
      ),
      payment_aggregates AS (
        SELECT event, customer, SUM(amount) AS total_paid
        FROM payments
        WHERE is_checked = true
        GROUP BY event, customer
      ),
      adjustment_aggregates AS (
        SELECT event, customer, SUM(amount) AS total_adj
        FROM adjustments
        GROUP BY event, customer
      )
      SELECT COUNT(*)::int AS count
      FROM order_aggregates oa
      LEFT JOIN customers c ON c.instagram_id = oa.customer
      -- Ongkir is the rate from the event's warehouse (per-event routing).
      LEFT JOIN events ev ON ev.name = oa.event
      LEFT JOIN customer_warehouse_ongkir cwo
        ON cwo.customer_id = c.id AND cwo.warehouse_id = ev.warehouse_id
      LEFT JOIN payment_aggregates pa ON pa.event = oa.event AND pa.customer = oa.customer
      LEFT JOIN adjustment_aggregates adj ON adj.event = oa.event AND adj.customer = oa.customer
      LEFT JOIN refunds r ON r.event = oa.event AND r.customer = oa.customer
        AND r.reason = 'overpayment' AND r.status != 'cancelled'
      WHERE r.id IS NULL
        AND COALESCE(pa.total_paid, 0) > (
          oa.subtotal
          + COALESCE(cwo.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
          + COALESCE(adj.total_adj, 0)
        )
    `,
    sql`
      SELECT status, COUNT(*)::int AS count
      FROM refunds
      WHERE status IN ('pending', 'awaiting_bank_info', 'ready_to_refund')
      GROUP BY status
    `,
    sql`
      SELECT COUNT(*)::int AS count FROM (
        SELECT 1
        FROM orders
        WHERE unit_buy IS NULL OR unit_buy < unit
        GROUP BY event, product_id
        HAVING SUM(unit - COALESCE(unit_buy, 0)) > 0
      ) g
    `,
    sql`
      SELECT COUNT(*)::int AS count FROM (
        SELECT 1
        FROM orders
        WHERE unit_buy IS NOT NULL
          AND (unit_arrive IS NULL OR unit_arrive < unit_buy)
        GROUP BY event, product_id
        HAVING SUM(unit_buy - COALESCE(unit_arrive, 0)) > 0
      ) g
    `,
    sql`
      SELECT COUNT(*)::int AS count FROM (
        SELECT 1
        FROM orders
        WHERE COALESCE(unit_arrive, 0) > COALESCE(unit_ship, 0)
        GROUP BY event, customer
      ) g
    `,
    sql`
      WITH order_aggregates AS (
        SELECT
          o.event,
          COUNT(*)::int AS order_count,
          COUNT(DISTINCT o.customer)::int AS customer_count,
          SUM(o.unit)::int AS total_units,
          SUM(o.unit * o.unit_price)::int AS total_subtotal,
          SUM(COALESCE(o.unit_buy, 0))::int AS total_bought,
          SUM(COALESCE(o.unit_arrive, 0))::int AS total_arrived,
          SUM(COALESCE(o.unit_ship, 0))::int AS total_shipped
        FROM orders o
        GROUP BY o.event
      ),
      payment_aggregates AS (
        SELECT event, SUM(amount)::int AS total_paid
        FROM payments
        WHERE is_checked = true
        GROUP BY event
      )
      SELECT
        e.name,
        COALESCE(e.eta, '') AS eta,
        oa.order_count,
        oa.customer_count,
        oa.total_units,
        oa.total_subtotal,
        oa.total_bought,
        oa.total_arrived,
        oa.total_shipped,
        COALESCE(pa.total_paid, 0)::int AS total_paid
      FROM order_aggregates oa
      JOIN events e ON e.name = oa.event
      LEFT JOIN payment_aggregates pa ON pa.event = oa.event
      WHERE oa.total_units > oa.total_shipped
      ORDER BY e.created_at DESC NULLS LAST, e.name
    `,
  ])

  const refundByStatus = new Map<string, number>()
  for (const r of refundCounts) refundByStatus.set(r.status as string, r.count as number)

  return {
    actionQueue: {
      overpaymentCandidates: (overpaymentCount[0]?.count as number) ?? 0,
      refundsPending: refundByStatus.get("pending") ?? 0,
      refundsAwaitingBankInfo: refundByStatus.get("awaiting_bank_info") ?? 0,
      refundsReadyToTransfer: refundByStatus.get("ready_to_refund") ?? 0,
      itemsPendingPurchase: (pendingPurchaseCount[0]?.count as number) ?? 0,
      itemsPendingArrival: (pendingArrivalCount[0]?.count as number) ?? 0,
      customersReadyToShip: (readyToShipCount[0]?.count as number) ?? 0,
    },
    events: eventRows.map((r) => ({
      name: r.name as string,
      eta: r.eta as string,
      orderCount: r.order_count as number,
      customerCount: r.customer_count as number,
      totalUnits: r.total_units as number,
      totalSubtotal: r.total_subtotal as number,
      totalBought: r.total_bought as number,
      totalArrived: r.total_arrived as number,
      totalShipped: r.total_shipped as number,
      totalPaid: r.total_paid as number,
    })),
  }
}
