import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getDuplicateFormRows } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const limitParam = req.nextUrl.searchParams.get("limit")
  const limit = limitParam ? parseInt(limitParam, 10) : undefined

  try {
    const rows = await getDuplicateFormRows(limit)
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch Duplicate_Form rows:", err)
    return NextResponse.json({ error: "Failed to fetch rows" }, { status: 500 })
  }
}
