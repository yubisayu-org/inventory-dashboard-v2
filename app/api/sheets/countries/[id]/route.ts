import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { updateCountry, deleteCountry } from "@/lib/db"

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const body = await req.json()
    const { name, currency, kurs, cargoPerKg } = body

    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }

    await updateCountry(id, {
      name: String(name),
      currency: String(currency ?? ""),
      kurs: Number(kurs ?? 0),
      cargoPerKg: Number(cargoPerKg ?? 0),
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update country:", err)
    return NextResponse.json({ error: "Failed to update country" }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    await deleteCountry(id)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete country:", err)
    return NextResponse.json({ error: "Failed to delete country" }, { status: 500 })
  }
}
