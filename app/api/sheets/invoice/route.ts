import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getInvoiceForCustomer } from "@/lib/db"
import { withServerTiming } from "@/lib/server-timing"

async function handleGET(req: NextRequest) {
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

// Timed: the response carries Server-Timing (total / db / dbmax / app).
// See lib/server-timing.ts for how to read it.
export const GET = withServerTiming(handleGET)
