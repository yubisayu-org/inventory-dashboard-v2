import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { recordReturnedUnits } from "@/lib/db/return-line"
import { REFUND_REASONS } from "@/lib/db/types"

// Goods came back. One action: the units are recorded on the line, the stock
// is logged, and the refund is priced from what her invoice actually fell by —
// so the ongkir the returned goods were carrying comes back with them, and
// somebody who has not paid simply owes less.

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const event = String(body.event ?? "").trim()
    const customer = String(body.customer ?? "").trim()
    const reason = String(body.reason ?? "").trim()
    const goods = String(body.goods ?? "")
    const lines = Array.isArray(body.lines) ? body.lines : []

    if (!event || !customer) {
      return NextResponse.json({ error: "event and customer are required" }, { status: 400 })
    }
    if (!(REFUND_REASONS as string[]).includes(reason)) {
      return NextResponse.json({ error: "Unknown refund reason" }, { status: 400 })
    }
    if (goods !== "returned" && goods !== "returned_unsellable") {
      return NextResponse.json({ error: "goods must say whether it can be sold again" }, { status: 400 })
    }

    const parsed = lines
      .map((l: { orderId?: unknown; qty?: unknown }) => ({
        orderId: Number(l.orderId),
        qty: Math.floor(Number(l.qty)),
      }))
      .filter((l: { orderId: number; qty: number }) => Number.isInteger(l.orderId) && l.qty > 0)
    if (parsed.length === 0) {
      return NextResponse.json({ error: "Pick what came back" }, { status: 400 })
    }

    const refunds = await recordReturnedUnits(
      { event, customer, reason, goods, lines: parsed },
      session.user.email,
    )
    return NextResponse.json({ success: true, refunds })
  } catch (err) {
    // Everything recordReturnedUnits throws is something the person can act
    // on — more units than were bought, an order that is not on this trip.
    const message = err instanceof Error ? err.message : "Failed to record the return"
    console.error("Failed to record a return:", err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
