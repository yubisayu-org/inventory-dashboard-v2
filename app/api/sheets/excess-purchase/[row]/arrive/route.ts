import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getExcessPurchaseRows, bulkUpdateExcessArrive, reconcileExcessOnArrival, withActor } from "@/lib/db"

type Params = { params: Promise<{ row: string }> }

/** Mark units of a single excess-purchase row arrived. No customer allocation
 *  involved — this just advances that row's own dispatch -> arrive stage. */
export async function POST(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const { row } = await params
  const rowNumber = Number(row)
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    return NextResponse.json({ error: "Invalid row number" }, { status: 400 })
  }

  try {
    const body = await req.json().catch(() => ({})) as {
      qty?: number
      /** Counted more than the row was carrying, and said to record it. */
      adjust?: boolean
      /** Counted fewer, and said nothing more is coming. */
      closeShort?: boolean
    }
    const qty = Number(body.qty)
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: "qty must be a positive number" }, { status: 400 })
    }

    const excessRow = (await getExcessPurchaseRows()).find((r) => r.rowNumber === rowNumber)
    if (!excessRow) {
      return NextResponse.json({ error: "Excess row not found" }, { status: 404 })
    }

    const current = excessRow.unitArrive ?? 0
    const dispatched = excessRow.unitDispatch ?? 0
    const bought = excessRow.unitBuy ?? 0
    const arrived = current + qty
    const cap = dispatched - current

    // More in the box than the paperwork said. Refused unless she has been
    // shown the two numbers and chosen -- a fat-fingered 50 must not silently
    // become fifty units of stock.
    if (qty > cap && !body.adjust) {
      return NextResponse.json(
        {
          error: `Only ${cap} unit(s) pending arrival`,
          needsAdjust: true,
          dispatched,
          counted: arrived,
          extra: arrived - dispatched,
        },
        { status: 409 },
      )
    }

    if (qty > cap) {
      // The units were always hers; the row had the wrong number on it.
      await withActor(session.user.email, (tx) => reconcileExcessOnArrival({
        rowNumber,
        unitBuy: Math.max(bought, arrived),
        unitDispatch: arrived,
        unitArrive: arrived,
      }, tx))
      return NextResponse.json({ success: true, unitArrive: arrived, adjusted: arrived - dispatched })
    }

    if (body.closeShort && arrived < dispatched) {
      // Nothing more is coming. Write the row down to what landed, so it stops
      // looking like something still on a boat.
      await withActor(session.user.email, (tx) => reconcileExcessOnArrival({
        rowNumber,
        unitBuy: Math.min(bought, arrived),
        unitDispatch: arrived,
        unitArrive: arrived,
      }, tx))
      return NextResponse.json({ success: true, unitArrive: arrived, closedShort: dispatched - arrived })
    }

    await withActor(session.user.email, (tx) => bulkUpdateExcessArrive(
      [{ rowNumber, unitArrive: arrived }],
      tx,
    ))

    return NextResponse.json({ success: true, unitArrive: arrived })
  } catch (err) {
    console.error("Failed to mark excess arrived:", err)
    return NextResponse.json({ error: "Failed to mark arrived" }, { status: 500 })
  }
}
