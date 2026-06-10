import sql from "../db-pool"

export interface TopProduct {
  productName: string
  store: string
  totalEvents: number
  totalUnits: number
  totalRevenue: number
}

export interface EventRevenueTrend {
  eventName: string
  createdAt: string
  totalUnits: number
  totalRevenue: number
  totalPaid: number
}

export interface LoyalCustomer {
  customer: string
  eventCount: number
  totalUnits: number
  totalSpend: number
}

export interface ProductRepeatRate {
  productName: string
  store: string
  eventCount: number
  totalUnits: number
  totalRevenue: number
}

export interface AnalyticsSummary {
  topProductsByUnits: TopProduct[]
  topProductsByRevenue: TopProduct[]
  eventRevenueTrend: EventRevenueTrend[]
  loyalCustomers: LoyalCustomer[]
  productRepeatRate: ProductRepeatRate[]
}

export async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  const [
    topByUnits,
    topByRevenue,
    eventTrend,
    loyal,
    repeatRate,
  ] = await Promise.all([
    sql`
      SELECT
        p.name AS product_name,
        p.store,
        COUNT(DISTINCT o.event)::int AS total_events,
        SUM(o.unit)::int AS total_units,
        SUM(o.unit * o.unit_price::bigint)::float8 AS total_revenue
      FROM orders o
      JOIN products p ON p.id = o.product_id
      GROUP BY p.name, p.store
      ORDER BY total_units DESC
      LIMIT 10
    `,
    sql`
      SELECT
        p.name AS product_name,
        p.store,
        COUNT(DISTINCT o.event)::int AS total_events,
        SUM(o.unit)::int AS total_units,
        SUM(o.unit * o.unit_price::bigint)::float8 AS total_revenue
      FROM orders o
      JOIN products p ON p.id = o.product_id
      GROUP BY p.name, p.store
      ORDER BY total_revenue DESC
      LIMIT 10
    `,
    sql`
      WITH order_agg AS (
        SELECT event,
          SUM(unit)::int AS total_units,
          SUM(unit * unit_price::bigint)::float8 AS total_revenue
        FROM orders
        GROUP BY event
      ),
      payment_agg AS (
        SELECT event, SUM(amount)::float8 AS total_paid
        FROM payments
        WHERE is_checked = true
        GROUP BY event
      )
      SELECT
        e.name AS event_name,
        COALESCE(e.created_at::text, '') AS created_at,
        oa.total_units,
        oa.total_revenue,
        COALESCE(pa.total_paid, 0) AS total_paid
      FROM events e
      JOIN order_agg oa ON oa.event = e.name
      LEFT JOIN payment_agg pa ON pa.event = e.name
      ORDER BY e.created_at ASC NULLS LAST, e.name
    `,
    sql`
      SELECT
        o.customer,
        COUNT(DISTINCT o.event)::int AS event_count,
        SUM(o.unit)::int AS total_units,
        SUM(o.unit * o.unit_price::bigint)::float8 AS total_spend
      FROM orders o
      GROUP BY o.customer
      HAVING COUNT(DISTINCT o.event) >= 2
      ORDER BY event_count DESC, total_spend DESC
      LIMIT 20
    `,
    sql`
      SELECT
        p.name AS product_name,
        p.store,
        COUNT(DISTINCT o.event)::int AS event_count,
        SUM(o.unit)::int AS total_units,
        SUM(o.unit * o.unit_price::bigint)::float8 AS total_revenue
      FROM orders o
      JOIN products p ON p.id = o.product_id
      GROUP BY p.name, p.store
      HAVING COUNT(DISTINCT o.event) >= 2
      ORDER BY event_count DESC, total_units DESC
      LIMIT 20
    `,
  ])

  return {
    topProductsByUnits: topByUnits.map((r) => ({
      productName: r.product_name as string,
      store: r.store as string,
      totalEvents: r.total_events as number,
      totalUnits: r.total_units as number,
      totalRevenue: r.total_revenue as number,
    })),
    topProductsByRevenue: topByRevenue.map((r) => ({
      productName: r.product_name as string,
      store: r.store as string,
      totalEvents: r.total_events as number,
      totalUnits: r.total_units as number,
      totalRevenue: r.total_revenue as number,
    })),
    eventRevenueTrend: eventTrend.map((r) => ({
      eventName: r.event_name as string,
      createdAt: r.created_at as string,
      totalUnits: r.total_units as number,
      totalRevenue: r.total_revenue as number,
      totalPaid: r.total_paid as number,
    })),
    loyalCustomers: loyal.map((r) => ({
      customer: r.customer as string,
      eventCount: r.event_count as number,
      totalUnits: r.total_units as number,
      totalSpend: r.total_spend as number,
    })),
    productRepeatRate: repeatRate.map((r) => ({
      productName: r.product_name as string,
      store: r.store as string,
      eventCount: r.event_count as number,
      totalUnits: r.total_units as number,
      totalRevenue: r.total_revenue as number,
    })),
  }
}
