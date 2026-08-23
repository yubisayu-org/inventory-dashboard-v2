import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { chargeSplitOngkir } from "@/lib/db"

// Bill the extra delivery fee on a customer's "send what has arrived" request.
// Shipping is not part of this: the fee is charged, she pays, and the parcel
// leaves through the ordinary Kirim button once the invoice is clear.

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const { customer, event } = (await req.json()) as { customer?: string; event?: string }
    if (!customer || !event) {
      return NextResponse.json({ error: "customer and event are required" }, { status: 400 })
    }
    const result = await chargeSplitOngkir({ customer, event }, session.user.email)
    return NextResponse.json(result)
  } catch (err) {
    // These refusals are the point of the endpoint, not failures of it: both
    // say something the person clicking needs to read.
    const message = err instanceof Error ? err.message : "Failed to charge shipping"
    console.error("Failed to charge split ongkir:", err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
