import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import {
  getExcessPurchaseRows,
  getDuplicateFormRowsForEvents,
  bulkUpdatePurchase,
  deleteExcessRow,
  updateExcessRowUnitBuy,
  withActor,
} from "@/lib/db"

type UpdatedRow = { rowNumber: number; customer: string; oldUnitBuy: number; unitBuy: number }
type ItemResult = { event: string; items: string; originalUnitBuy: number; filled: UpdatedRow[]; remainder: number }

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireOwner(session)
  if (roleError) return roleError

  try {
    const body = await req.json().catch(() => ({})) as { receipt?: string }
    const receipt = body.receipt ? String(body.receipt).trim() : ""

    // Broken inventory is tracked but never sellable, so exclude it from the
    // apply-to-orders working set entirely (not matched, not deleted/updated).
    const excessRows = (await getExcessPurchaseRows()).filter((r) => r.reason !== "broken")

    if (excessRows.length === 0) {
      return NextResponse.json({ results: [] })
    }

    // Each excess row is only ever matched against form rows of its own event
    // (see the r.event === excessRow.event filter below), so fetch orders for
    // just those events instead of the whole orders table.
    const events = [...new Set(excessRows.map((r) => r.event))]
    const formRows = await getDuplicateFormRowsForEvents(events)

    // Working copy of unitBuy so sequential excess rows see each other's allocations
    const workingUnitBuy = new Map<number, number>()
    for (const r of formRows) workingUnitBuy.set(r.rowNumber, r.unitBuy ?? 0)

    // Accumulate Duplicate_Form updates (keyed by rowNumber to merge multi-excess fills)
    const formUpdates = new Map<number, { customer: string; oldUnitBuy: number; unitBuy: number; receipt: string }>()

    const results: ItemResult[] = []
    const excessToDelete: number[] = []
    const excessToUpdate: { rowNumber: number; unitBuy: number }[] = []

    for (const excessRow of excessRows) {
      const eligible = formRows
        .filter(
          (r) =>
            r.event === excessRow.event &&
            r.items === excessRow.items &&
            (workingUnitBuy.get(r.rowNumber) ?? 0) < r.unit,
        )
        .sort((a, b) => a.rowNumber - b.rowNumber)

      let remaining = excessRow.unitBuy
      const filled: UpdatedRow[] = []

      for (const r of eligible) {
        if (remaining <= 0) break
        const current = workingUnitBuy.get(r.rowNumber) ?? 0
        const allocate = Math.min(r.unit - current, remaining)
        const newUnitBuy = current + allocate

        // Accumulate receipt — chain if this row is touched by multiple excess rows
        const existingReceipt = formUpdates.has(r.rowNumber)
          ? formUpdates.get(r.rowNumber)!.receipt
          : (r.receipt ?? "")
        const combinedReceipt = receipt
          ? existingReceipt ? `${existingReceipt}, ${receipt}` : receipt
          : existingReceipt

        formUpdates.set(r.rowNumber, {
          customer: r.customer,
          // preserve the original unitBuy from before this whole batch
          oldUnitBuy: formUpdates.get(r.rowNumber)?.oldUnitBuy ?? current,
          unitBuy: newUnitBuy,
          receipt: combinedReceipt,
        })
        workingUnitBuy.set(r.rowNumber, newUnitBuy)
        filled.push({ rowNumber: r.rowNumber, customer: r.customer, oldUnitBuy: current, unitBuy: newUnitBuy })
        remaining -= allocate
      }

      results.push({ event: excessRow.event, items: excessRow.items, originalUnitBuy: excessRow.unitBuy, filled, remainder: remaining })

      if (remaining <= 0) {
        excessToDelete.push(excessRow.rowNumber)
      } else {
        excessToUpdate.push({ rowNumber: excessRow.rowNumber, unitBuy: remaining })
      }
    }

    // 1. Write all Duplicate_Form updates in one batch
    await withActor(session.user.email, (tx) => bulkUpdatePurchase(
      Array.from(formUpdates.entries()).map(([rowNumber, d]) => ({
        rowNumber,
        unitBuy: d.unitBuy,
        receipt: d.receipt,
      })),
      tx,
    ))

    // 2. Update partially-consumed excess rows (before deletes shift row numbers)
    for (const { rowNumber, unitBuy } of excessToUpdate) {
      await withActor(session.user.email, (tx) => updateExcessRowUnitBuy(rowNumber, unitBuy, tx))
    }

    // 3. Delete fully-consumed excess rows highest-first so lower indices stay valid
    for (const rowNumber of excessToDelete.sort((a, b) => b - a)) {
      await withActor(session.user.email, (tx) => deleteExcessRow(rowNumber, tx))
    }

    return NextResponse.json({ results })
  } catch (err) {
    console.error("Failed to bulk apply excess:", err)
    return NextResponse.json({ error: "Failed to apply" }, { status: 500 })
  }
}

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireOwner(session)
  if (roleError) return roleError

  try {
    const rows = await getExcessPurchaseRows()
    return NextResponse.json({ rows })
  } catch (err) {
    console.error("Failed to fetch excess purchase rows:", err)
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 })
  }
}
