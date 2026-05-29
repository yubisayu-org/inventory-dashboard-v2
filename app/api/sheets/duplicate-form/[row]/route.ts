import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { updateFormRow, updateFormRowStage2, updateFormRowStage3, updateFormRowOwnerQty, deleteFormRow } from "@/lib/db"

type Params = { params: Promise<{ row: string }> }

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

    if (stage === "2") {
      // Owner only
      if (session.user.role !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const { unitBuy, receipt } = body
      if (unitBuy == null) {
        return NextResponse.json({ error: "unitBuy is required" }, { status: 400 })
      }
      await updateFormRowStage2(rowNumber, {
        unitBuy: Number(unitBuy),
        receipt: receipt ? String(receipt) : "",
      })

    } else if (stage === "3") {
      const { unitArrive, unitShip, unitHold } = body
      if (unitArrive == null || unitShip == null || unitHold == null) {
        return NextResponse.json({ error: "unitArrive, unitShip, unitHold are required" }, { status: 400 })
      }
      await updateFormRowStage3(rowNumber, {
        unitArrive: Number(unitArrive),
        unitShip: Number(unitShip),
        unitHold: Number(unitHold),
      })

    } else if (stage === "owner_qty") {
      // Owner-only manual correction of unit_arrive and unit_hold from the
      // List Order edit modal. unit_ship intentionally not editable here —
      // shipped units are owned by the Ship/Shipments flow.
      if (session.user.role !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const { unitArrive, unitHold } = body
      await updateFormRowOwnerQty(rowNumber, {
        unitArrive: unitArrive == null || unitArrive === "" ? null : Number(unitArrive),
        unitHold: unitHold == null || unitHold === "" ? null : Number(unitHold),
      })

    } else {
      // Stage 1 — order details
      const { event, customer, productId, unitPrice, unit, note } = body
      // `unit == null` (not `!unit`) so 0 is accepted — admins occasionally
      // zero out an order to cancel it while keeping the row for history.
      if (!event || !customer || !productId || unit == null) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
      }
      await updateFormRow(rowNumber, {
        event: String(event),
        customer: String(customer),
        productId: Number(productId),
        unitPrice: Number(unitPrice ?? 0),
        unit: Number(unit),
        note: note ? String(note) : "",
      })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
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
    await deleteFormRow(rowNumber)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete row:", err)
    return NextResponse.json({ error: "Failed to delete row" }, { status: 500 })
  }
}
