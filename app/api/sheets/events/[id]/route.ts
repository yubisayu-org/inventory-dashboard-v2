import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { updateEvent, deleteEvent, withActor } from "@/lib/db"

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
    const { name, eta, warehouseId } = body

    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }

    await withActor(session.user.email, (tx) => updateEvent(id, {
      name: String(name),
      eta: String(eta ?? ""),
      warehouseId: warehouseId != null ? Number(warehouseId) : null,
    }, tx))

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update event:", err)
    return NextResponse.json({ error: "Failed to update event" }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
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
    await withActor(session.user.email, (tx) => deleteEvent(id, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete event:", err)
    return NextResponse.json({ error: "Failed to delete event" }, { status: 500 })
  }
}
