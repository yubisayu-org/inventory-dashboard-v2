import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getSheetOptions } from "@/lib/db"

export async function GET() {
  const { session, error } = await requireSession()
  if (error) return error

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const options = await getSheetOptions()
    return NextResponse.json(options)
  } catch (err) {
    console.error("Sheets API error:", err)
    return NextResponse.json({ error: "Failed to fetch sheet data" }, { status: 500 })
  }
}
