import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import {
  getExcessPurchaseRows,
  getDuplicateFormRows,
  bulkUpdatePurchase,
  deleteExcessRow,
  updateExcessRowUnitBuy,
} from "@/lib/db"

type Params = { params: Promise<{ row: string }> }
type UpdatedRow = { rowNumber: number; customer: string; oldUnitBuy: number; unitBuy: number }

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

    const [excessRows, formRows] = await Promise.all([
      getExcessPurchaseRows(),
      getDuplicateFormRows(),
    ])

    const excessRow = excessRows.find((r) => r.rowNumber === rowNumber)
    if (!excessRow) {
      return NextResponse.json({ error: "Excess row not found" }, { status: 404 })
    }

    // Eligible: same event + item, unitBuy not yet fully filled, sorted chronologically
    const eligible = formRows
      .filter(
        (r) =>
          r.event === excessRow.event &&
          r.items === excessRow.items &&
          (r.unitBuy ?? 0) < r.unit,
      )
      .sort((a, b) => a.rowNumber - b.rowNumber)

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
        customer: r.customer,
        oldUnitBuy: current,
        unitBuy: current + allocate,
        receipt: combinedReceipt,
      })
      remaining -= allocate
    }

    await bulkUpdatePurchase(
      updates.map(({ rowNumber: rn, unitBuy, receipt }) => ({ rowNumber: rn, unitBuy, receipt })),
    )

    if (remaining <= 0) {
      await deleteExcessRow(rowNumber)
    } else {
      await updateExcessRowUnitBuy(rowNumber, remaining)
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
