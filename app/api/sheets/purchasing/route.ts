import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getDuplicateFormRowsForEvent, bulkUpdatePurchase, appendExcessPurchase } from "@/lib/db"

type ItemLine = { item: string; qty: number }
type UpdatedRow = { rowNumber: number; customer: string; oldUnitBuy: number; unitBuy: number }
type FormRows = Awaited<ReturnType<typeof getDuplicateFormRowsForEvent>>

/** Build a map of item name → eligible rows (sorted chronologically). */
function buildEligibleMap(rows: FormRows): Map<string, FormRows> {
  const map = new Map<string, FormRows>()
  for (const r of rows) {
    if ((r.unitBuy ?? 0) >= r.unit) continue
    const group = map.get(r.items)
    if (group) group.push(r)
    else map.set(r.items, [r])
  }
  for (const group of map.values()) group.sort((a, b) => a.rowNumber - b.rowNumber)
  return map
}

function distribute(
  eligible: FormRows,
  item: string,
  qty: number,
  receipt: string,
): {
  updates: (UpdatedRow & { receipt: string })[]
  itemResult: { item: string; rows: UpdatedRow[]; excess: number }
} {
  let remaining = qty
  const updates: (UpdatedRow & { receipt: string })[] = []

  for (const row of eligible) {
    if (remaining <= 0) break
    const current = row.unitBuy ?? 0
    const allocate = Math.min(row.unit - current, remaining)
    const existingReceipt = row.receipt ?? ""
    const combinedReceipt = receipt
      ? (existingReceipt ? `${existingReceipt}, ${receipt}` : receipt)
      : existingReceipt
    updates.push({
      rowNumber: row.rowNumber,
      customer: row.customer,
      oldUnitBuy: current,
      unitBuy: current + allocate,
      receipt: combinedReceipt,
    })
    remaining -= allocate
  }

  return {
    updates,
    itemResult: {
      item,
      rows: updates.map(({ receipt: _r, ...rest }) => rest),
      excess: remaining,
    },
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireOwner(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const { event, items, receipt } = body as {
      event: string
      items: ItemLine[]
      receipt?: string
    }

    if (!event || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "event and at least one item are required" }, { status: 400 })
    }

    for (const line of items) {
      if (!line.item) return NextResponse.json({ error: "Each line must have an item" }, { status: 400 })
      const q = Number(line.qty)
      if (!Number.isFinite(q) || q <= 0) {
        return NextResponse.json({ error: `qty for "${line.item}" must be a positive number` }, { status: 400 })
      }
    }

    const rows = await getDuplicateFormRowsForEvent(event)
    const receiptStr = receipt ? String(receipt) : ""
    const eligibleMap = buildEligibleMap(rows)

    const allUpdates: (UpdatedRow & { receipt: string })[] = []
    const results: { item: string; rows: UpdatedRow[]; excess: number }[] = []
    const excessRows: { event: string; items: string; unitBuy: number; receipt: string }[] = []

    for (const line of items) {
      const eligible = eligibleMap.get(line.item) ?? []
      const { updates, itemResult } = distribute(eligible, line.item, Number(line.qty), receiptStr)
      allUpdates.push(...updates)
      results.push(itemResult)
      if (itemResult.excess > 0) {
        excessRows.push({ event, items: line.item, unitBuy: itemResult.excess, receipt: receiptStr })
      }
    }

    await Promise.all([
      bulkUpdatePurchase(
        allUpdates.map(({ rowNumber, unitBuy, receipt: r }) => ({ rowNumber, unitBuy, receipt: r })),
      ),
      appendExcessPurchase(excessRows),
    ])

    return NextResponse.json({ results })
  } catch (err) {
    console.error("Failed to process purchasing:", err)
    return NextResponse.json({ error: "Failed to process" }, { status: 500 })
  }
}
