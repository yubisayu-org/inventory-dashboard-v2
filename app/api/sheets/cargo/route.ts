import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getCargo, getEventCargos, setCargoWeight } from "@/lib/db"
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

  try {
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
 * The weight, which is the only figure a cargo keeps.
 *
 * Everything else it shows is read from somewhere that already owns it -- the
 * arrivals, the manifest, the expense ledger -- so this is the whole writer.
 */
export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const receipt = String(body?.receipt ?? "").trim()
    if (!receipt) return NextResponse.json({ error: "receipt is required" }, { status: 400 })

    const raw = body?.weightKg
    const weightKg = raw === null || raw === "" || raw === undefined ? null : Number(raw)
    if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 0)) {
      return NextResponse.json({ error: "The weight must be a number of kilos" }, { status: 400 })
    }

    await withActor(session!.user.email ?? "dashboard", (tx) =>
      setCargoWeight(receipt, weightKg === null ? null : Math.round(weightKg), String(body?.note ?? ""), tx))
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to save the cargo weight:", err)
    return NextResponse.json({ error: "Failed to save the weight" }, { status: 500 })
  }
}
