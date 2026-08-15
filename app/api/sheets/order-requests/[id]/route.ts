import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { convertCatalogueRequest, rejectCatalogueRequest } from "@/lib/db"

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const body = await req.json()

    if (body.action === "convert") {
      const event = String(body.event ?? "")
      if (!event) return NextResponse.json({ error: "event is required" }, { status: 400 })
      const result = await convertCatalogueRequest(id, event, session.user.email ?? null)
      return NextResponse.json({ success: true, orderId: result.orderId })
    }

    if (body.action === "reject") {
      const staffNote = String(body.staffNote ?? "")
      await rejectCatalogueRequest(id, staffNote)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: "action must be 'convert' or 'reject'" }, { status: 400 })
  } catch (err) {
    console.error("Failed to update order request:", err)
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update request" }, { status: 500 })
  }
}
