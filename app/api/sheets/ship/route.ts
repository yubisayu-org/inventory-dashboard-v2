import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getShipOrders, shipCustomerOrders } from "@/lib/db"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const data = await getShipOrders()
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
    const result = await shipCustomerOrders(body)
    return NextResponse.json(result)
  } catch (err) {
    console.error("Failed to ship orders:", err)
    return NextResponse.json({ error: "Failed to ship orders" }, { status: 500 })
  }
}
