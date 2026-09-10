import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getDispatchDocument } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const params = req.nextUrl.searchParams
  const event = params.get("event")?.trim() || null
  // Optional receipt prefix; blank → no filter. One of the two is required:
  // a trip's document, or a box's — and a box's covers the box, whichever
  // trips its goods belong to.
  const receipt = params.get("receipt")?.trim() || null
  if (!event && !receipt) {
    return NextResponse.json({ error: "event or receipt is required" }, { status: 400 })
  }

  try {
    const lines = await getDispatchDocument(event, receipt)
    return NextResponse.json(
      { event, receipt, lines },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to fetch dispatch document:", err)
    return NextResponse.json({ error: "Failed to fetch dispatch document" }, { status: 500 })
  }
}
