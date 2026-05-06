import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getInvoiceForCustomer } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const instagramId = req.nextUrl.searchParams.get("customer")?.trim()
  if (!instagramId) {
    return NextResponse.json({ error: "customer is required" }, { status: 400 })
  }

  try {
    const data = await getInvoiceForCustomer(instagramId)
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load invoice:", err)
    return NextResponse.json({ error: "Failed to load invoice" }, { status: 500 })
  }
}
