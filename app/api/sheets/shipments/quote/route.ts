import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { repriceShippedRedirect } from "@/lib/db/redirect-ongkir"

// What correcting this parcel's address would do to her bill — asked before
// anything is saved, so the person correcting it sees the figure and decides.
// `apply` is false here by construction: this route only ever answers.

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const rowNumber = Number(body.rowNumber)
    const areaId = String(body.areaId ?? "").trim()
    if (!Number.isInteger(rowNumber) || !areaId) {
      return NextResponse.json({ error: "rowNumber and areaId are required" }, { status: 400 })
    }
    const quote = await repriceShippedRedirect(rowNumber, areaId, String(body.areaName ?? ""), false)
    return NextResponse.json({ quote })
  } catch (err) {
    console.error("Failed to quote a shipment redirect:", err)
    return NextResponse.json({ error: "Failed to quote" }, { status: 500 })
  }
}
