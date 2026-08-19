import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { revokeCustomer } from "@/lib/db/catalogue-auth"

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  let body: { customerId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const customerId = Number(body.customerId)
  if (!Number.isInteger(customerId) || customerId < 1) {
    return NextResponse.json({ error: "customerId must be a positive integer" }, { status: 400 })
  }

  try {
    // Ends live sessions in the same transaction as the flag — otherwise a
    // revoked customer keeps their access until their current session expires.
    await revokeCustomer(customerId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to revoke catalogue customer:", err)
    return NextResponse.json({ error: "Failed to revoke" }, { status: 500 })
  }
}
