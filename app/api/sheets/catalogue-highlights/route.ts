import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getCatalogueHighlights, createCatalogueHighlight, withActor } from "@/lib/db"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const highlights = await getCatalogueHighlights()
    return NextResponse.json({ highlights }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch catalogue highlights:", err)
    return NextResponse.json({ error: "Failed to fetch catalogue highlights" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    const name = String(body.name ?? "").trim()
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }
    const defaultEvent = body.defaultEvent ? String(body.defaultEvent) : null
    const sortOrder = Number.isInteger(body.sortOrder) ? body.sortOrder : 0

    const result = await withActor(session.user.email ?? null, (tx) =>
      createCatalogueHighlight({ name, defaultEvent, sortOrder }, tx),
    )
    return NextResponse.json({ success: true, id: result.id })
  } catch (err) {
    console.error("Failed to create catalogue highlight:", err)
    return NextResponse.json({ error: "Failed to create highlight" }, { status: 500 })
  }
}
