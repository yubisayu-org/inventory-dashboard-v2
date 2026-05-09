import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { updateProduct, deleteProduct } from "@/lib/db"

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
    if (!String(body.name ?? "").trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }

    await updateProduct(id, {
      name: String(body.name).trim(),
      store: String(body.store ?? "").trim(),
      price: Number(body.price) || 0,
      gram: Number(body.gram) || 0,
      countryId: body.countryId != null ? Number(body.countryId) : null,
      valas: Number(body.valas) || 0,
      kurs: Number(body.kurs) || 0,
      cargoPerKg: Number(body.cargoPerKg) || 0,
      profitPct: Number(body.profitPct) || 0,
      operationalFee: Number(body.operationalFee ?? 5000),
      packingFee: Number(body.packingFee ?? 5000),
      cost: Number(body.cost) || 0,
      profitFixed: Number(body.profitFixed) || 0,
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update product:", err)
    return NextResponse.json({ error: "Failed to update product" }, { status: 500 })
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
    await deleteProduct(id)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete product:", err)
    return NextResponse.json({ error: "Failed to delete product" }, { status: 500 })
  }
}
