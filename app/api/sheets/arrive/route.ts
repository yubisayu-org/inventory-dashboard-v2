import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import {
  getDuplicateFormRowsForEvent,
  bulkUpdateArrive,
  appendExcessPurchase,
  type ExcessReason,
} from "@/lib/db"

type ItemLine = { item: string; qty: number; expectedItem?: string }
type UpdatedRow = { rowNumber: number; customer: string; oldUnitArrive: number; unitArrive: number }
type FormRows = Awaited<ReturnType<typeof getDuplicateFormRowsForEvent>>
type ItemResult = {
  item: string
  expectedItem?: string
  rows: UpdatedRow[]
  unmatched: number
  loggedAs?: Extract<ExcessReason, "overship" | "wrong_product">
}

function buildEligibleMap(rows: FormRows): Map<string, FormRows> {
  const map = new Map<string, FormRows>()
  for (const r of rows) {
    const unitBuy = r.unitBuy ?? 0
    if (unitBuy <= 0) continue
    if ((r.unitArrive ?? 0) >= unitBuy) continue
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
): { updates: UpdatedRow[]; unmatched: number } {
  let remaining = qty
  const updates: UpdatedRow[] = []

  for (const row of eligible) {
    if (remaining <= 0) break
    const current = row.unitArrive ?? 0
    const capacity = (row.unitBuy ?? 0) - current
    const allocate = Math.min(capacity, remaining)
    updates.push({
      rowNumber: row.rowNumber,
      customer: row.customer,
      oldUnitArrive: current,
      unitArrive: current + allocate,
    })
    remaining -= allocate
  }

  return { updates, unmatched: remaining }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const { event, items } = body as { event: string; items: ItemLine[] }

    if (!event || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "event and at least one item are required" }, { status: 400 })
    }

    const normalized: ItemLine[] = []
    for (const line of items) {
      if (!line.item) return NextResponse.json({ error: "Each line must have an item" }, { status: 400 })
      const q = Number(line.qty)
      if (!Number.isFinite(q) || q <= 0) {
        return NextResponse.json({ error: `qty for "${line.item}" must be a positive number` }, { status: 400 })
      }
      const expectedItem = line.expectedItem?.trim() || undefined
      if (expectedItem && expectedItem === line.item) {
        return NextResponse.json(
          { error: `Expected item cannot equal received item for "${line.item}"` },
          { status: 400 },
        )
      }
      normalized.push({ item: line.item, qty: q, expectedItem })
    }

    const rows = await getDuplicateFormRowsForEvent(event)
    const eligibleMap = buildEligibleMap(rows)

    const allUpdates: UpdatedRow[] = []
    const results: ItemResult[] = []
    const excessRows: {
      event: string
      items: string
      unitBuy: number
      receipt: string
      reason: ExcessReason
      expectedItem?: string
    }[] = []

    for (const line of normalized) {
      if (line.expectedItem) {
        excessRows.push({
          event,
          items: line.item,
          unitBuy: line.qty,
          receipt: "",
          reason: "wrong_product",
          expectedItem: line.expectedItem,
        })
        results.push({
          item: line.item,
          expectedItem: line.expectedItem,
          rows: [],
          unmatched: line.qty,
          loggedAs: "wrong_product",
        })
        continue
      }

      const eligible = eligibleMap.get(line.item) ?? []
      const { updates, unmatched } = distribute(eligible, line.item, line.qty)
      allUpdates.push(...updates)

      const result: ItemResult = { item: line.item, rows: updates, unmatched }
      if (unmatched > 0) {
        excessRows.push({
          event,
          items: line.item,
          unitBuy: unmatched,
          receipt: "",
          reason: "overship",
        })
        result.loggedAs = "overship"
      }
      results.push(result)
    }

    await Promise.all([
      bulkUpdateArrive(
        allUpdates.map(({ rowNumber, unitArrive }) => ({ rowNumber, unitArrive })),
      ),
      appendExcessPurchase(excessRows),
    ])

    return NextResponse.json({ results })
  } catch (err) {
    console.error("Failed to process unit arrive:", err)
    return NextResponse.json({ error: "Failed to process" }, { status: 500 })
  }
}
