import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getWarehouses, setWarehouseOrigin, createWarehouse } from "@/lib/db"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    // Not cached: this screen exists to show what has just been changed.
    return NextResponse.json(
      { warehouses: await getWarehouses() },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to load warehouses:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  let body: {
    action?: unknown
    warehouseId?: unknown
    code?: unknown
    name?: unknown
    biteshipAreaId?: unknown
    biteshipAreaName?: unknown
    postalCode?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (body.action === "create") {
    const code = String(body.code ?? "").trim()
    const name = String(body.name ?? "").trim()
    if (!/^[A-Za-z0-9_-]{2,20}$/.test(code)) {
      return NextResponse.json(
        { error: "Code must be 2-20 letters, digits, hyphen or underscore" },
        { status: 400 },
      )
    }
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 })
    }
    try {
      const created = await createWarehouse({ code, name })
      // hasRates travels back so the UI can say plainly that nothing can be
      // priced from here yet, rather than letting it look ready.
      return NextResponse.json({ ok: true, ...created })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create"
      return NextResponse.json({ error: message }, { status: 409 })
    }
  }

  const warehouseId = Number(body.warehouseId)
  const biteshipAreaId = String(body.biteshipAreaId ?? "").trim()
  const biteshipAreaName = String(body.biteshipAreaName ?? "").trim()
  const postalCode = String(body.postalCode ?? "").trim()

  if (!Number.isInteger(warehouseId) || warehouseId < 1) {
    return NextResponse.json({ error: "warehouseId must be a positive integer" }, { status: 400 })
  }
  if (!biteshipAreaId || !biteshipAreaName) {
    return NextResponse.json({ error: "Choose an area from the search results" }, { status: 400 })
  }

  try {
    await setWarehouseOrigin(warehouseId, { biteshipAreaId, biteshipAreaName, postalCode })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to set warehouse origin:", err)
    return NextResponse.json({ error: "Failed to save" }, { status: 500 })
  }
}
