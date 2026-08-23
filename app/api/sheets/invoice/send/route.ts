import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { withActor } from "@/lib/db"
import { notifyCustomer } from "@/lib/db/announcements"

// "Send invoice" — telling her the figure is ready, not transporting it.
//
// Her invoice is already live on the catalogue, rendered from this same data.
// What has been missing is the moment someone says pay this. That moment is an
// announcement: it carries the figure asked for and the date it was asked, and
// it is what the shop can point at later when the total has since moved.
//
// Deliberately no frozen snapshot. A discount after sending makes her
// overpaid, which the invoice already says and refunds already handle.

function idr(n: number): string {
  return `Rp ${Math.round(n).toLocaleString("id-ID")}`
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json().catch(() => ({}))
    const event = String(body.event ?? "")
    const customer = String(body.customer ?? "")
    const outstanding = Number(body.outstanding ?? 0)

    if (!event || !customer) {
      return NextResponse.json({ error: "event and customer are required" }, { status: 400 })
    }
    if (!Number.isFinite(outstanding) || outstanding <= 0) {
      return NextResponse.json({ error: "Nothing outstanding to ask for" }, { status: 400 })
    }

    await withActor(session.user.email, (tx) => notifyCustomer(customer, {
      title: `${event} · ${idr(outstanding)} due`,
      body: `Your order is ready to settle. Open it in Order history to see the items and `
        + `tell us once you have transferred — we check it against the bank ourselves.`,
    }, tx))

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to send invoice notice:", err)
    return NextResponse.json({ error: "Failed to send invoice" }, { status: 500 })
  }
}
