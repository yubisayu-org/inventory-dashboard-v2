import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, isAdmin } from "@/lib/api"
import { withActor } from "@/lib/db"
import { rejectCustomerPayment, unrejectCustomerPayment } from "@/lib/db/catalogue-payments"

// Refusing a reported payment, and taking the refusal back.
//
// Owner-only, for the same reason ticking one is: both decide whether money
// counts. An admin session is refused here exactly as it is on isChecked.

type Params = { params: Promise<{ row: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError
  if (isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { row } = await params
  const id = Number(row)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid row number" }, { status: 400 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    // The notice to her goes in the same transaction as the refusal: a refused
    // payment she is never told about is the silence this feature exists to end.
    await withActor(session.user.email, (tx) => rejectCustomerPayment(id, String(body.reason ?? ""), tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reject payment"
    console.error("Failed to reject payment:", err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError
  if (isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { row } = await params
  const id = Number(row)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid row number" }, { status: 400 })
  }

  try {
    await withActor(session.user.email, (tx) => unrejectCustomerPayment(id, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to un-reject payment:", err)
    return NextResponse.json({ error: "Failed to update payment" }, { status: 500 })
  }
}
