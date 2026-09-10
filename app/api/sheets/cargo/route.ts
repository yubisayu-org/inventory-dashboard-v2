import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import {
  getCargo, getEventCargos, setCargoWeight, describeCargo, renameCargo, setBoxCargo,
} from "@/lib/db"
import { withActor } from "@/lib/db/actor"

/**
 * A delivery: what it brought, and what it cost.
 *
 * `?receipt=CJI-9981` is the whole sheet; `?event=…` lists the deliveries a
 * trip's arrivals named, for the strip and the receipt field's suggestions.
 */
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const params = req.nextUrl.searchParams
  const receipt = (params.get("receipt") ?? "").trim()
  const event = (params.get("event") ?? "").trim()
  const describe = (params.get("describe") ?? "").trim()

  try {
    // What already lives under a code she is typing, so a rename that would
    // silently merge two real deliveries says so first.
    if (describe) {
      return NextResponse.json({ there: await describeCargo(describe) },
        { headers: { "Cache-Control": "no-store" } })
    }
    if (receipt) {
      const cargo = await getCargo(receipt)
      if (!cargo) {
        return NextResponse.json({ error: `Nothing has been counted in against ${receipt}` }, { status: 404 })
      }
      return NextResponse.json({ cargo }, { headers: { "Cache-Control": "no-store" } })
    }
    if (event) {
      return NextResponse.json({ cargos: await getEventCargos(event) },
        { headers: { "Cache-Control": "no-store" } })
    }
    return NextResponse.json({ error: "receipt or event is required" }, { status: 400 })
  } catch (err) {
    console.error("Failed to read the cargo:", err)
    return NextResponse.json({ error: "Failed to read the cargo" }, { status: 500 })
  }
}

/**
 * The three things a person can change about a delivery.
 *
 * Its weight, which is the only figure it keeps; its code, when the one typed
 * at arrival was wrong; and which delivery a single box belongs to. The last
 * two are the same statement with a different WHERE, and are kept apart
 * because the question is different: "this delivery is really X" against
 * "this box came on X".
 */
export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const action = String(body?.action ?? "weight")
    const actor = session!.user.email ?? "dashboard"

    if (action === "rename") {
      const from = String(body?.from ?? "").trim()
      const to = String(body?.to ?? "").trim()
      if (!from || !to) {
        return NextResponse.json({ error: "from and to are required" }, { status: 400 })
      }
      const moved = await withActor(actor, (tx) => renameCargo(from, to, tx))
      return NextResponse.json({ ok: true, ...moved, receipt: to.toUpperCase() })
    }

    if (action === "move-box") {
      const box = String(body?.box ?? "").trim()
      if (!box) return NextResponse.json({ error: "box is required" }, { status: 400 })
      // Blank is allowed and meant: the code on it is wrong, and which
      // delivery it really came on is not known yet.
      const moved = await withActor(actor, (tx) =>
        setBoxCargo(box, String(body?.to ?? "").trim(), tx))
      return NextResponse.json({ ok: true, ...moved })
    }

    const receipt = String(body?.receipt ?? "").trim()
    if (!receipt) return NextResponse.json({ error: "receipt is required" }, { status: 400 })

    const raw = body?.weightKg
    const weightKg = raw === null || raw === "" || raw === undefined ? null : Number(raw)
    if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 0)) {
      return NextResponse.json({ error: "The weight must be a number of kilos" }, { status: 400 })
    }

    await withActor(actor, (tx) =>
      setCargoWeight(receipt, weightKg === null ? null : Math.round(weightKg), String(body?.note ?? ""), tx))
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to write the cargo:", err)
    const message = err instanceof Error ? err.message : "Failed to save"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
