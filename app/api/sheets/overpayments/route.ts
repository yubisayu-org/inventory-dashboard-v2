import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { listOverpaymentsToCheck, createRefundFromOverpayment } from "@/lib/db"

// Money a customer is owed that no refund covers. Read by the Refunds page's
// "To check" tab and counted on the Dashboard, which must agree with it.
//
// Role, not ownership: /dashboard/refunds is in ADMIN_ROUTES, so an admin
// works this list too.
export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    return NextResponse.json(
      { rows: await listOverpaymentsToCheck() },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to list overpayments to check:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  let body: { event?: unknown; customer?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const event = typeof body.event === "string" ? body.event.trim() : ""
  const customer = typeof body.customer === "string" ? body.customer.trim() : ""
  if (!event || !customer) {
    return NextResponse.json({ error: "event and customer are required" }, { status: 400 })
  }

  try {
    // Not wrapped in withActor: that opens a transaction, and
    // createRefundFromOverpayment opens its own. Nesting them deadlocks on the
    // same connection — the trap issueInvite already documents. It takes the
    // actor directly and sets app.actor inside its own transaction.
    const made = await createRefundFromOverpayment(event, customer, session.user.email)
    return NextResponse.json(made)
  } catch (err) {
    // "Nothing is uncovered" is the caller acting on a list that has moved on,
    // not a fault — 409, with the reason, so the page can say what happened.
    const message = err instanceof Error ? err.message : "Failed to create refund"
    console.error("Failed to create a refund from an overpayment:", err)
    return NextResponse.json({ error: message }, { status: 409 })
  }
}
