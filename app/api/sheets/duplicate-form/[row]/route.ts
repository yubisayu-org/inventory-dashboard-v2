import { NextRequest, NextResponse } from "next/server"
import sql from "@/lib/db-pool"
import { requireSession, requireRole } from "@/lib/api"
import { updateFormRow, updateFormRowStage2, updateFormRowStage3, updateOrderOwnerCell, reapplyHoldsForArrival, updateOrderNote, updateOrderReceipt, updateOrderDispatchReceipt, deleteFormRow, returnOrderUnitsToExcess, withActor } from "@/lib/db"
import { strandedBoughtUnits, bankStrandedBoughtUnits } from "@/lib/db/orders"
import type { DBExecutor } from "@/lib/db/actor"

type Params = { params: Promise<{ row: string }> }

/** Signals a save that would leave bought units attached to nothing. */
class AlreadyShipped extends Error {
  constructor(readonly shipped: number) {
    super(`${shipped} unit(s) have already shipped`)
    this.name = "AlreadyShipped"
  }
}

class StrandedUnits extends Error {
  constructor(readonly count: number) {
    super(`${count} bought unit(s) would belong to no order`)
    this.name = "StrandedUnits"
  }
}

/** Units already gone. Nothing at this door may take an order below them. */
async function shippedUnits(rowNumber: number, tx: DBExecutor): Promise<number> {
  const [row] = (await tx`
    SELECT COALESCE(unit_ship, 0) AS unit_ship FROM orders WHERE id = ${rowNumber}
  `) as unknown as { unit_ship: number }[]
  return Number(row?.unit_ship ?? 0)
}

async function strandedAfterEdit(rowNumber: number, tx: DBExecutor): Promise<number> {
  const [row] = (await tx`
    SELECT unit, COALESCE(unit_buy, 0) AS unit_buy FROM orders WHERE id = ${rowNumber}
  `) as unknown as { unit: number; unit_buy: number }[]
  return row ? strandedBoughtUnits(Number(row.unit), Number(row.unit_buy)) : 0
}

export async function PUT(req: NextRequest, { params }: Params) {
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
    const body = await req.json()
    const stage = String(body.stage ?? "1")
    // Why the order shrank. Both answers shelve the units; they are different
    // facts, and the one nobody records is the one nobody can reconstruct.
    const cause = body.cause === "customer_changed_mind" ? "customer_changed_mind" : "staff_mistake"

    if (stage === "2") {
      // Owner only
      if (session.user.role !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const { unitBuy, receipt } = body
      if (unitBuy == null) {
        return NextResponse.json({ error: "unitBuy is required" }, { status: 400 })
      }
      await withActor(session.user.email, (tx) => updateFormRowStage2(rowNumber, {
        unitBuy: Number(unitBuy),
        receipt: receipt ? String(receipt) : "",
      }, tx))

    } else if (stage === "3") {
      const { unitArrive, unitShip, unitHold } = body
      if (unitArrive == null || unitShip == null || unitHold == null) {
        return NextResponse.json({ error: "unitArrive, unitShip, unitHold are required" }, { status: 400 })
      }
      await withActor(session.user.email, (tx) => updateFormRowStage3(rowNumber, {
        unitArrive: Number(unitArrive),
        unitShip: Number(unitShip),
        unitHold: Number(unitHold),
      }, tx))

    } else if (stage === "owner_cell") {
      // Owner-only inline cell edit from the List Order table — updates one
      // column at a time so sibling fields (unit_hold, receipt, etc.) aren't
      // clobbered by what was meant to be a partial edit.
      if (session.user.role !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const { column, value } = body
      if (column !== "unit_buy" && column !== "unit_arrive" && column !== "unit_dispatch") {
        return NextResponse.json({ error: "Invalid column" }, { status: 400 })
      }
      const numericValue = value == null || value === "" ? null : Number(value)
      if (numericValue !== null && !Number.isFinite(numericValue)) {
        return NextResponse.json({ error: "value must be a number or null" }, { status: 400 })
      }
      const bankedCell = await withActor(session.user.email, async (tx) => {
        await updateOrderOwnerCell(rowNumber, column, numericValue, tx)
        // Editing unit_arrive by hand raises arrivals the same way receiving
        // does, so a standing hold has to be re-applied here too — otherwise
        // one inline edit unparks a held order without saying so.
        if (column === "unit_arrive") {
          const [row] = await tx<{ event: string; customer: string }[]>`
            SELECT event, customer FROM orders WHERE id = ${rowNumber}`
          if (row) await reapplyHoldsForArrival(row.event, [row.customer], tx)
        }
        // Recording more bought than were ordered strands the surplus just as
        // surely as shrinking the order does — same question, asked once.
        const stranded = await strandedAfterEdit(rowNumber, tx)
        if (stranded === 0) return 0
        if (body.bankStranded !== true) throw new StrandedUnits(stranded)
        const { banked } = await bankStrandedBoughtUnits(rowNumber, tx, cause)
        return banked
      })
      return NextResponse.json({ success: true, banked: bankedCell })

    } else if (stage === "receipt_cell") {
      // Inline receipt edit — owner-only (receipt is set during purchasing).
      if (session.user.role !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const receipt = body.value == null ? "" : String(body.value)
      await withActor(session.user.email, (tx) => updateOrderReceipt(rowNumber, receipt, tx))

    } else if (stage === "dispatch_receipt_cell") {
      // Inline dispatch-receipt edit — owner-only (dispatch_receipt is set/appended
      // during dispatch, and had no edit path until now).
      if (session.user.role !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const dispatchReceipt = body.value == null ? "" : String(body.value)
      await withActor(session.user.email, (tx) => updateOrderDispatchReceipt(rowNumber, dispatchReceipt, tx))

    } else if (stage === "note_cell") {
      // Inline note edit from the List Order table. Notes are not owner-only
      // (admins edit them via the modal too), so role access is sufficient.
      const note = body.value == null ? "" : String(body.value)
      await withActor(session.user.email, (tx) => updateOrderNote(rowNumber, note, tx))

    } else if (stage === "return_excess") {
      // Owner-only: remove units from this order and bank the bought-but-not-
      // yet-arrived surplus into excess_purchase (reverting a mistaken order).
      if (session.user.role !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const removeUnits = Number(body.removeUnits)
      if (!Number.isInteger(removeUnits) || removeUnits < 1) {
        return NextResponse.json({ error: "removeUnits must be a positive integer" }, { status: 400 })
      }
      try {
        const result = await withActor(session.user.email, (tx) => returnOrderUnitsToExcess(rowNumber, removeUnits, tx))
        return NextResponse.json({ success: true, ...result })
      } catch (e) {
        // Guard violations (e.g. units already arrived) are user-actionable.
        return NextResponse.json(
          { error: e instanceof Error ? e.message : "Failed to return units" },
          { status: 400 },
        )
      }

    } else {
      // Stage 1 — order details
      const { event, customer, productId, unitPrice, unit, note } = body
      // `unit == null` (not `!unit`) so 0 is accepted — admins occasionally
      // zero out an order to cancel it while keeping the row for history.
      if (!event || !customer || !productId || unit == null) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
      }
      const banked = await withActor(session.user.email, async (tx) => {
        // A parcel that has gone is not an order that can be shrunk. Whatever
        // the reason, the goods are with her and what is owed for them is a
        // refund's business -- this is the edit that quietly un-billed
        // Rp 5.721.000 of delivered goods.
        const gone = await shippedUnits(rowNumber, tx)
        if (Number(unit) < gone) throw new AlreadyShipped(gone)

        await updateFormRow(rowNumber, {
          event: String(event),
          customer: String(customer),
          productId: Number(productId),
          unitPrice: Number(unitPrice ?? 0),
          unit: Number(unit),
          note: note ? String(note) : "",
        }, tx)

        // A unit that was bought is either on somebody's order or on the
        // shelf. If this edit has left it on neither, it does not silently
        // stop existing: the caller is asked once, and says which.
        const stranded = await strandedAfterEdit(rowNumber, tx)
        if (stranded === 0) return 0
        if (body.bankStranded !== true) throw new StrandedUnits(stranded)
        const { banked } = await bankStrandedBoughtUnits(rowNumber, tx)
        return banked
      })
      return NextResponse.json({ success: true, banked })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    // Not a failure — a question. The edit is refused until somebody says what
    // happened to the units, and the transaction has already rolled back, so
    // nothing was half-saved while asking.
    if (err instanceof AlreadyShipped) {
      return NextResponse.json(
        {
          error: `${err.shipped} unit sudah dikirim, jadi pesanannya tidak bisa dikurangi. `
            + `Barangnya ada di customer — kalau uangnya perlu kembali, itu refund.`,
        },
        { status: 409 },
      )
    }
    if (err instanceof StrandedUnits) {
      return NextResponse.json(
        { error: "stranded_units", stranded: err.count },
        { status: 409 },
      )
    }
    console.error("Failed to update row:", err)
    return NextResponse.json({ error: "Failed to update row" }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
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
    // Deleting an order that money has already been spent on is worse than
    // shrinking one. A shrink strands the bought units -- findable, and now
    // guarded -- but a delete takes the row with them, so nothing records that
    // the units were ever ordered, bought or dispatched. They simply stop
    // existing on paper while sitting in a box.
    //
    // Refused rather than banked automatically: reducing the quantity is the
    // door that asks why and puts the stock on the shelf under the right
    // reason, and it keeps the row. There is no answer this endpoint could
    // guess on the caller's behalf.
    const [row] = (await sql`
      SELECT COALESCE(unit_buy, 0) AS bought, COALESCE(unit_ship, 0) AS shipped
        FROM orders WHERE id = ${rowNumber}
    `) as unknown as { bought: number; shipped: number }[]

    if (row && Number(row.shipped) > 0) {
      return NextResponse.json(
        {
          error: `${row.shipped} unit already shipped, so this order cannot be deleted. `
            + `The goods are with the customer — if money needs to go back, that is a refund.`,
        },
        { status: 409 },
      )
    }
    if (row && Number(row.bought) > 0) {
      return NextResponse.json(
        {
          error: `${row.bought} unit already bought for this order, so deleting it would lose `
            + `the stock. Set the quantity to 0 instead — that asks why and puts the units into `
            + `Inventory.`,
        },
        { status: 409 },
      )
    }

    await withActor(session.user.email, (tx) => deleteFormRow(rowNumber, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete row:", err)
    return NextResponse.json({ error: "Failed to delete row" }, { status: 500 })
  }
}
