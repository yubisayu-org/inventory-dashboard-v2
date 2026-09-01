import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getShipOrdersFiltered, shipCustomerOrders, shipMergedCustomerOrders, PairedShipmentError, NoShippingRateError, type ShipSegment } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const url = req.nextUrl
    const segment = (url.searchParams.get("segment") ?? "all") as ShipSegment
    const search = url.searchParams.get("search") ?? ""
    const event = url.searchParams.get("event") ?? ""

    const data = await getShipOrdersFiltered({ segment, search, event })
    return NextResponse.json(data)
  } catch (err) {
    console.error("Failed to load ready-to-ship orders:", err)
    return NextResponse.json({ error: "Failed to load orders" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    // A "Ship together" payload carries `groups` (one customer, several events);
    // a single-event ship carries `event` + `orders`.
    const result = Array.isArray(body?.groups)
      ? await shipMergedCustomerOrders(body, session.user.email)
      : await shipCustomerOrders(body, session.user.email)
    return NextResponse.json(result)
  } catch (err) {
    // Not a failure: the customer asked for these to travel together, and the
    // screen turns this into a confirm rather than an error.
    // Also not a server failure: somebody has to set a rate, and saying so is
    // more use than "Failed to ship orders".
    if (err instanceof NoShippingRateError) {
      return NextResponse.json({ error: err.message, noRate: true, events: err.events }, { status: 409 })
    }
    if (err instanceof PairedShipmentError) {
      return NextResponse.json(
        { error: err.message, paired: true, partners: err.partners },
        { status: 409 },
      )
    }
    console.error("Failed to ship orders:", err)
    return NextResponse.json({ error: "Failed to ship orders" }, { status: 500 })
  }
}
