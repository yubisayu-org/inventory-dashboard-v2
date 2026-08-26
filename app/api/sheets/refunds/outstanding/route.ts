import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { outstandingElsewhere, outstandingByCustomer } from "@/lib/db"

// Where else one customer owes money, so a refund can be offered as credit
// against a real debt instead of the person working it having to remember one.
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const customer = req.nextUrl.searchParams.get("customer")?.trim() ?? ""
  const exclude = req.nextUrl.searchParams.get("exclude")?.trim() ?? ""

  try {
    // Named customer → their trips. No customer → everyone's, in one pass, for
    // a page that would otherwise look each row up on its own.
    const body = customer
      ? { trips: await outstandingElsewhere(customer, exclude) }
      : { byCustomer: await outstandingByCustomer() }
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to look up outstanding balances:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}
