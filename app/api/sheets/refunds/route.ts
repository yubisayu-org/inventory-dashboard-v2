import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getRefunds, createRefund, materializeOverpaymentRefunds } from "@/lib/db"
import type { RefundReason } from "@/lib/db"

const VALID_REASONS: RefundReason[] = ["overpayment", "unavailable", "shipping_loss", "damaged", "goodwill", "other"]

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const { searchParams } = req.nextUrl
  const event = searchParams.get("event") ?? undefined
  const status = searchParams.get("status") ?? undefined
  const customer = searchParams.get("customer") ?? undefined

  try {
    // Auto-create pending refunds for any detected overpayments before listing.
    // Idempotent: skips pairs that already have an active overpayment refund.
    try {
      await materializeOverpaymentRefunds()
    } catch (err) {
      console.error("Failed to auto-create overpayment refunds:", err)
      // Continue to list whatever's already there; one bad write shouldn't
      // hide the entire refunds page.
    }

    const rows = await getRefunds({ event, status, customer })
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch refunds:", err)
    return NextResponse.json({ error: "Failed to fetch refunds" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const { event, customer, reason, refundAmount, orderId, affectedUnits, note } = await req.json()

    if (!event || !customer || !reason || typeof refundAmount !== "number" || refundAmount < 1) {
      return NextResponse.json(
        { error: "event, customer, reason and refundAmount are required" },
        { status: 400 },
      )
    }
    if (!VALID_REASONS.includes(reason)) {
      return NextResponse.json({ error: "Invalid reason" }, { status: 400 })
    }

    const row = await createRefund({
      event,
      customer,
      reason,
      refundAmount,
      orderId: orderId ?? null,
      affectedUnits: affectedUnits ?? 0,
      note: note ?? "",
    })
    return NextResponse.json({ success: true, row })
  } catch (err) {
    console.error("Failed to create refund:", err)
    return NextResponse.json({ error: "Failed to create refund" }, { status: 500 })
  }
}
