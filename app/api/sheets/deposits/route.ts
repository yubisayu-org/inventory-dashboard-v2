import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { heldDeposits } from "@/lib/db"

/**
 * What this customer is holding that has not been spent.
 *
 * Read where the billing happens, so the invoice can offer it instead of
 * asking her for money she has already given you.
 */
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const customer = req.nextUrl.searchParams.get("customer")?.trim()
  if (!customer) {
    return NextResponse.json({ error: "customer is required" }, { status: 400 })
  }

  try {
    return NextResponse.json(
      { deposits: await heldDeposits(customer) },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to fetch held deposits:", err)
    return NextResponse.json({ error: "Failed to fetch deposits" }, { status: 500 })
  }
}
