import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getDashboardSummary } from "@/lib/db"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const summary = await getDashboardSummary()
    return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch dashboard summary:", err)
    return NextResponse.json({ error: "Failed to fetch summary" }, { status: 500 })
  }
}
