import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getShoppingList, getSellableExcessTotals, applyExcessToShoppingItem, markProductBought, markProductOutOfStock, withActor } from "@/lib/db"
import { withServerTiming } from "@/lib/server-timing"

async function handleGET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event") ?? undefined

  try {
    const [items, excessByItem] = await Promise.all([
      getShoppingList(event),
      getSellableExcessTotals(),
    ])
    return NextResponse.json({ items, excessByItem }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch shopping list:", err)
    return NextResponse.json({ error: "Failed to fetch shopping list" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  try {
    const body = await req.json()

    // Out-of-stock: FIFO-reduce pending order quantities, and refund whoever
    // had already paid for the units that went — with the reason, and a notice.
    if (body.action === "out_of_stock") {
      const { event, productId, quantityOutOfStock } = body
      if (!event || !productId || typeof quantityOutOfStock !== "number" || quantityOutOfStock < 1) {
        return NextResponse.json({ error: "event, productId and quantityOutOfStock are required" }, { status: 400 })
      }
      // Which lines lose the units, when the shop has chosen them itself. The
      // quantity still travels, because it is what the screen said out loud.
      let allocations: { orderId: number; units: number }[] | undefined
      if (body.allocations !== undefined) {
        if (!Array.isArray(body.allocations) || body.allocations.length === 0) {
          return NextResponse.json({ error: "allocations must be a non-empty list" }, { status: 400 })
        }
        allocations = body.allocations.map((a: unknown) => {
          const row = a as { orderId?: unknown; units?: unknown }
          if (!Number.isInteger(row.orderId) || !Number.isInteger(row.units) || Number(row.units) < 1) {
            throw new Error("each allocation needs an orderId and at least one unit")
          }
          return { orderId: Number(row.orderId), units: Number(row.units) }
        })
        const named = new Set(allocations!.map((a) => a.orderId))
        if (named.size !== allocations!.length) {
          return NextResponse.json({ error: "the same order is listed twice" }, { status: 400 })
        }
      }
      try {
        const result = await markProductOutOfStock(
          { event, productId: Number(productId), quantityOutOfStock, allocations }, session.user.email)
        return NextResponse.json({ success: true, ...result })
      } catch (err) {
        // The refusals inside are about her choice -- an order that has been
        // bought since the screen was drawn, a figure that no longer fits --
        // and she can act on every one of them. A generic 500 could not.
        const msg = err instanceof Error ? err.message : "Failed to mark out of stock"
        console.error("Failed to mark out of stock:", err)
        return NextResponse.json({ error: msg }, { status: 400 })
      }
    }

    // Apply excess: pull from existing sellable excess_purchase stock instead
    // of buying more. Mirrors the Inventory page's Apply Excess, started from
    // the order side.
    if (body.action === "apply_excess") {
      const { event, productId, productName, qty, receipt } = body
      if (!event || !productId || !productName || typeof qty !== "number" || qty < 1) {
        return NextResponse.json({ error: "event, productId, productName and qty are required" }, { status: 400 })
      }
      const result = await withActor(session.user.email, (tx) => applyExcessToShoppingItem(
        { event, productId: Number(productId), productName, qty, receipt: receipt ? String(receipt).trim() : "" },
        tx,
      ))
      return NextResponse.json({ success: true, ...result })
    }

    const { event, productId, productName, quantityBought, receipt } = body
    if (!event || !productId || !productName || typeof quantityBought !== "number" || quantityBought < 1) {
      return NextResponse.json({ error: "event, productId, productName and quantityBought are required" }, { status: 400 })
    }
    const result = await markProductBought({ event, productId: Number(productId), productName, quantityBought, receipt: receipt ?? "" }, session.user.email)
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    console.error("Failed to process shopping-list action:", err)
    return NextResponse.json({ error: "Failed to process request" }, { status: 500 })
  }
}

// Timed: the response carries Server-Timing (total / db / dbmax / app).
// See lib/server-timing.ts for how to read it.
export const GET = withServerTiming(handleGET)
