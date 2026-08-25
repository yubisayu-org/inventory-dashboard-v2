import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import sql from "@/lib/db-pool"

export interface EventTopItem {
  productName: string
  store: string
  totalUnits: number
  totalRevenue: number
}

export interface EventAnalytics {
  topItems: EventTopItem[]
}

export async function GET(req: NextRequest) {
  // Owner-only: its one consumer is the Dashboard, which admins cannot open,
  // and it reports units sold and revenue per trip. Nothing guarded it before —
  // /api is outside the middleware matcher — so anyone who could guess an event
  // code could read what that trip earned.
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const event = req.nextUrl.searchParams.get("event")
  if (!event) return NextResponse.json({ error: "event required" }, { status: 400 })

  const rows = await sql`
    SELECT
      p.name AS product_name,
      p.store,
      SUM(o.unit)::int AS total_units,
      SUM(o.unit * o.unit_price)::int AS total_revenue
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.event = ${event}
    GROUP BY p.name, p.store
    ORDER BY total_units DESC
    LIMIT 5
  `

  const topItems: EventTopItem[] = rows.map((r) => ({
    productName: r.product_name as string,
    store: r.store as string,
    totalUnits: r.total_units as number,
    totalRevenue: r.total_revenue as number,
  }))

  return NextResponse.json({ topItems } satisfies EventAnalytics)
}
