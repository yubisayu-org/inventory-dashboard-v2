import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getExcessPurchaseRows, bulkUpdateExcessDispatch, recordExcessDispatchManifest, reconcileExcessOnArrival, withActor } from "@/lib/db"

type Params = { params: Promise<{ row: string }> }

/** Mark units of a single excess-purchase row dispatched. No customer
 *  allocation involved — this just advances that row's own buy -> dispatch stage. */
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
      receipt?: string
      /** Packing more than the row says was bought, and said to record it. */
      adjust?: boolean
    }
    const qty = Number(body.qty)
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: "qty must be a positive number" }, { status: 400 })
    }

    const excessRow = (await getExcessPurchaseRows()).find((r) => r.rowNumber === rowNumber)
    if (!excessRow) {
      return NextResponse.json({ error: "Excess row not found" }, { status: 404 })
    }

    const current = excessRow.unitDispatch ?? 0
    const bought = excessRow.unitBuy
    const dispatched = current + qty
    const cap = bought - current

    // More in her hands than the row says was bought. Refused unless she has
    // been shown both numbers and chosen: at this stage there is no box to
    // check against, so the confirm is the only guard a mistyped quantity meets.
    //
    // Same shape as the Receiving List's, one stage earlier — how many spare
    // units were bought is a number that can be learnt at the hotel while
    // packing, not only when the parcel is opened weeks later.
    if (qty > cap && !body.adjust) {
      return NextResponse.json(
        {
          error: `Only ${cap} unit(s) pending dispatch`,
          needsAdjust: true,
          bought,
          counted: dispatched,
          extra: dispatched - bought,
        },
        { status: 409 },
      )
    }

    const receipt = body.receipt ? String(body.receipt).trim() : ""
    const existingReceipt = excessRow.dispatchReceipt
    const combinedReceipt = receipt
      ? (existingReceipt ? `${existingReceipt}, ${receipt}` : receipt)
      : existingReceipt

    await withActor(session.user.email, async (tx) => {
      // Raising unit_buy alongside unit_dispatch, never one without the other:
      // each stage is capped by the one before it, so dispatching five against
      // a bought two would leave ready stock clamped at two by
      // LEAST(unit_arrive, unit_buy) and strand three units nobody can order.
      if (dispatched > bought) {
        await reconcileExcessOnArrival(
          { rowNumber, unitBuy: dispatched, unitDispatch: dispatched, unitArrive: excessRow.unitArrive ?? 0 },
          tx,
        )
        await bulkUpdateExcessDispatch(
          [{ rowNumber, unitDispatch: dispatched, dispatchReceipt: combinedReceipt }],
          tx,
        )
      } else {
        await bulkUpdateExcessDispatch(
          [{ rowNumber, unitDispatch: dispatched, dispatchReceipt: combinedReceipt }],
          tx,
        )
      }
      // Surplus rides in the same parcel as the customer orders, so it belongs
      // on the same manifest -- otherwise a box carrying it reads light against
      // what the courier weighed. Only when a box was actually named: nothing
      // is recorded for a dispatch with no tracking number, exactly as on the
      // orders side.
      await recordExcessDispatchManifest(
        { event: excessRow.event, itemName: excessRow.items, receipt, qty },
        tx,
      )
    })

    return NextResponse.json({
      success: true,
      unitDispatch: dispatched,
      ...(dispatched > bought ? { adjusted: dispatched - bought } : {}),
    })
  } catch (err) {
    console.error("Failed to mark excess dispatched:", err)
    return NextResponse.json({ error: "Failed to mark dispatched" }, { status: 500 })
  }
}
