import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import {
  getExcessPurchaseRows,
  getDuplicateFormRowsForItems,
  bulkUpdatePurchase,
  deleteExcessRow,
  updateExcessRowUnitBuy,
  updateExcessRow,
  withActor,
} from "@/lib/db"
import type { ExcessReason } from "@/lib/db"

const EXCESS_REASONS: ExcessReason[] = ["overbuy", "overship", "wrong_product", "broken", "customer_cancelled", "manual"]

type Params = { params: Promise<{ row: string }> }
type UpdatedRow = { rowNumber: number; event: string; customer: string; oldUnitBuy: number; unitBuy: number }

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
    const body = await req.json().catch(() => ({})) as { receipt?: string }
    const receipt = body.receipt ? String(body.receipt).trim() : ""

    const excessRows = await getExcessPurchaseRows()

    const excessRow = excessRows.find((r) => r.rowNumber === rowNumber)
    if (!excessRow) {
      return NextResponse.json({ error: "Excess row not found" }, { status: 404 })
    }
    if (excessRow.reason === "broken") {
      return NextResponse.json({ error: "Broken inventory can't be applied to orders" }, { status: 400 })
    }

    // Matched by item name across all events (scoped to this item), so an
    // excess row can spill into other events' orders when its own event is
    // already covered.
    const formRows = await getDuplicateFormRowsForItems([excessRow.items])

    // Eligible: same item, unitBuy not yet fully filled. Fill the excess row's
    // own event first, then spill to other events, oldest-first within each.
    const eligible = formRows
      .filter(
        (r) =>
          r.items === excessRow.items &&
          (r.unitBuy ?? 0) < r.unit,
      )
      .sort(
        (a, b) =>
          (Number(b.event === excessRow.event) - Number(a.event === excessRow.event)) ||
          (a.rowNumber - b.rowNumber),
      )

    if (eligible.length === 0) {
      return NextResponse.json({ filled: [], remainder: excessRow.unitBuy })
    }

    let remaining = excessRow.unitBuy
    const updates: (UpdatedRow & { receipt: string })[] = []

    for (const r of eligible) {
      if (remaining <= 0) break
      const current = r.unitBuy ?? 0
      const allocate = Math.min(r.unit - current, remaining)
      const existingReceipt = r.receipt ?? ""
      const combinedReceipt = receipt
        ? existingReceipt
          ? `${existingReceipt}, ${receipt}`
          : receipt
        : existingReceipt
      updates.push({
        rowNumber: r.rowNumber,
        event: r.event,
        customer: r.customer,
        oldUnitBuy: current,
        unitBuy: current + allocate,
        receipt: combinedReceipt,
      })
      remaining -= allocate
    }

    await withActor(session.user.email, (tx) => bulkUpdatePurchase(
      updates.map(({ rowNumber: rn, unitBuy, receipt }) => ({ rowNumber: rn, unitBuy, receipt })),
      tx,
    ))

    if (remaining <= 0) {
      await withActor(session.user.email, (tx) => deleteExcessRow(rowNumber, tx))
    } else {
      await withActor(session.user.email, (tx) => updateExcessRowUnitBuy(rowNumber, remaining, tx))
    }

    return NextResponse.json({
      filled: updates.map(({ receipt: _r, ...rest }) => rest),
      remainder: remaining,
    })
  } catch (err) {
    console.error("Failed to apply excess:", err)
    return NextResponse.json({ error: "Failed to apply" }, { status: 500 })
  }
}

/**
 * Edit an inventory row's event/item/quantity/reason/receipt. "Apply" fills the
 * row's own event first and then spills to matching orders in other events, so
 * retargeting the event only changes fill priority, not what's reachable.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
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
    const { event, items, unitBuy, receipt, reason } = body as {
      event?: string
      items?: string
      unitBuy?: number
      receipt?: string
      reason?: string
    }

    if (reason !== undefined && !EXCESS_REASONS.includes(reason as ExcessReason)) {
      return NextResponse.json({ error: "Invalid reason" }, { status: 400 })
    }
    if (unitBuy !== undefined && (typeof unitBuy !== "number" || unitBuy < 1)) {
      return NextResponse.json({ error: "unitBuy must be a positive number" }, { status: 400 })
    }

    await withActor(session.user.email, (tx) => updateExcessRow(rowNumber, {
      event,
      items,
      unitBuy,
      receipt,
      reason: reason as ExcessReason | undefined,
    }, tx))

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update excess row:", err)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
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
    await withActor(session.user.email, (tx) => deleteExcessRow(rowNumber, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete excess row:", err)
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 })
  }
}
