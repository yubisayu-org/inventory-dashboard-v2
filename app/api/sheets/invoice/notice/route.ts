import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { withActor } from "@/lib/db"
import { sendInvoiceNotice } from "@/lib/db/notices"

// One notice to one customer's inbox, and the refund it announces if there is
// one. Both in the same transaction: a refund without its notice is money she
// is never told about, and a notice without its refund is a promise nothing
// records.

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json().catch(() => ({}))
    const result = await withActor(session.user.email, (tx) => sendInvoiceNotice({
      event: String(body.event ?? ""),
      customer: String(body.customer ?? ""),
      title: String(body.title ?? ""),
      body: String(body.body ?? ""),
      refund: body.refund
        ? {
            cause: String(body.refund.cause ?? ""),
            amount: Number(body.refund.amount ?? 0),
            orderId: body.refund.orderId ?? null,
            affectedUnits: Number(body.refund.affectedUnits ?? 0),
            items: String(body.refund.items ?? ""),
          }
        : null,
    }, tx))
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    // Everything sendInvoiceNotice throws is something the sender can fix —
    // a missing field, a bad token, a refund with no amount.
    const message = err instanceof Error ? err.message : "Failed to send notice"
    console.error("Failed to send invoice notice:", err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
