import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getArrivalList, getExcessArrivalPending, markProductArrived, recordCustomerCancellation, recordNotReceived, renameDispatchReceipt, withActor } from "@/lib/db"
import { withServerTiming } from "@/lib/server-timing"

async function handleGET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event") ?? undefined
  // Absent or "all" means every route. The receiving list names one so the
  // response carries that route's parcels rather than everything in transit.
  const route = req.nextUrl.searchParams.get("route") ?? undefined

  try {
    const [items, excessPending] = await Promise.all([
      getArrivalList(event, route),
      getExcessArrivalPending(event),
    ])
    return NextResponse.json({ items, excessPending }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch arrival list:", err)
    return NextResponse.json({ error: "Failed to fetch arrival list" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  try {
    const body = await req.json()

    // Packing runs ahead of paperwork: a box leaves as "MNC - box 1" and the
    // courier's number turns up later. Renaming moves every line of that
    // parcel, because the receipt is what makes them one box.
    if (body.action === "rename_receipt") {
      const from = String(body.from ?? "").trim()
      const to = String(body.to ?? "").trim()
      if (!from || !to) {
        return NextResponse.json({ error: "from and to are required" }, { status: 400 })
      }
      if (to.length > 120) {
        return NextResponse.json({ error: "That tracking number is too long" }, { status: 400 })
      }
      const result = await withActor(session.user?.email ?? null, (tx) =>
        renameDispatchReceipt(from, to, tx))
      if (result.moved === 0) {
        return NextResponse.json(
          { error: "Nothing was renamed — that parcel may have been renamed already" },
          { status: 409 },
        )
      }
      return NextResponse.json({ success: true, ...result })
    }

    // Wrong-product path: supplier sent a different SKU. Log it to ready stock
    // and zero the chosen customer orders, refunding whoever had paid for them.
    if (body.action === "wrong_product") {
      const { event, expectedItem, receivedItem, qty } = body
      if (!event || !expectedItem || !receivedItem || typeof qty !== "number" || qty < 1) {
        return NextResponse.json(
          { error: "event, expectedItem, receivedItem and qty are required" },
          { status: 400 },
        )
      }
      if (receivedItem === expectedItem) {
        return NextResponse.json(
          { error: "Received item must differ from the expected item" },
          { status: 400 },
        )
      }
      const cancelOrderIds = Array.isArray(body.cancelOrderIds)
        ? body.cancelOrderIds.filter((n: unknown) => Number.isInteger(n)) as number[]
        : []
      // Same function the quantity flow uses, narrowed to the chosen orders:
      // only the marked quantity comes off, whoever it comes off. Cancelling
      // whole lines instead used to strip units nobody had marked, leaving the
      // surviving stock on no order and in no inventory.
      const result = await recordNotReceived(
        { event, productId: Number(body.productId), productName: expectedItem, qty,
          mode: "wrong", receivedItem, orderIds: cancelOrderIds },
        session.user.email,
      )
      return NextResponse.json({ success: true, ...result })
    }

    // Broken path: the expected item arrived damaged. Log the broken units to
    // inventory flagged 'broken' (tracked but never assignable to orders) and
    // cancel the chosen customer orders, refunding whoever had paid for them.
    if (body.action === "broken") {
      const { event, productName, qty } = body
      if (!event || !productName || typeof qty !== "number" || qty < 1) {
        return NextResponse.json(
          { error: "event, productName and qty are required" },
          { status: 400 },
        )
      }
      const cancelOrderIds = Array.isArray(body.cancelOrderIds)
        ? body.cancelOrderIds.filter((n: unknown) => Number.isInteger(n)) as number[]
        : []
      const result = await recordNotReceived(
        { event, productId: Number(body.productId), productName, qty,
          mode: "broken", orderIds: cancelOrderIds },
        session.user.email,
      )
      return NextResponse.json({ success: true, ...result })
    }

    // Missing path: the expected item never arrived. Like broken: take the
    // marked quantity off the chosen orders, refund whoever had paid, and log
    // the units flagged "missing" — unassignable, but a record of the loss.
    if (body.action === "missing") {
      const { event } = body
      const cancelOrderIds = Array.isArray(body.cancelOrderIds)
        ? body.cancelOrderIds.filter((n: unknown) => Number.isInteger(n)) as number[]
        : []
      if (!event || cancelOrderIds.length === 0 || !(Number(body.qty) >= 1)) {
        return NextResponse.json(
          { error: "event, a quantity and at least one order to cancel are required" },
          { status: 400 },
        )
      }
      const result = await recordNotReceived(
        { event, productId: Number(body.productId), productName: String(body.productName ?? "").trim(),
          qty: Number(body.qty), mode: "missing", orderIds: cancelOrderIds },
        session.user.email,
      )
      return NextResponse.json({ success: true, ...result })
    }

    // Customer-cancelled path: the item is correct and already bought, but the
    // customer backed out (misunderstanding, changed their mind). Log the
    // already-bought units to inventory as ready stock (reason=customer_cancelled,
    // assignable to the next order) and cancel the chosen orders (refunds
    // auto-materialize if paid).
    if (body.action === "customer_cancelled") {
      const { event, productName, receipt } = body
      const cancelOrderIds = Array.isArray(body.cancelOrderIds)
        ? body.cancelOrderIds.filter((n: unknown) => Number.isInteger(n)) as number[]
        : []
      if (!event || !productName || cancelOrderIds.length === 0) {
        return NextResponse.json(
          { error: "event, productName and at least one order to cancel are required" },
          { status: 400 },
        )
      }
      const result = await withActor(session.user.email, (tx) =>
        recordCustomerCancellation({ event, productName, cancelOrderIds, receipt: typeof receipt === "string" ? receipt : undefined }, tx),
      )
      return NextResponse.json({ success: true, ...result })
    }

    // Bulk "Not Received": record a delivery problem against `qty` units of one
    // product, allocated across its waiting orders by priority (recordNotReceived
    // runs its own transaction + actor).
    if (body.action === "not_received") {
      const { event, productId, productName, qty, mode, receivedItem } = body
      const validModes = ["wrong", "broken", "missing", "cancelled"]
      if (!event || !productId || !productName || typeof qty !== "number" || qty < 1 || !validModes.includes(mode)) {
        return NextResponse.json(
          { error: "event, productId, productName, qty (>=1) and a valid mode are required" },
          { status: 400 },
        )
      }
      if (mode === "wrong" && (!receivedItem || receivedItem === productName)) {
        return NextResponse.json(
          { error: "A wrong delivery needs a received item different from the expected one" },
          { status: 400 },
        )
      }
      const result = await recordNotReceived(
        { event, productId: Number(productId), productName, qty, mode, receivedItem },
        session.user.email,
      )
      return NextResponse.json({ success: true, ...result })
    }

    const { event, productId, quantityArrived } = body
    if (!event || !productId || typeof quantityArrived !== "number" || quantityArrived < 1) {
      return NextResponse.json(
        { error: "event, productId and quantityArrived are required" },
        { status: 400 },
      )
    }
    const result = await markProductArrived({
      event,
      productId: Number(productId),
      quantityArrived,
    }, session.user.email)
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    console.error("Failed to mark orders as arrived:", err)
    return NextResponse.json({ error: "Failed to mark as arrived" }, { status: 500 })
  }
}

// Timed: the response carries Server-Timing (total / db / dbmax / app).
// See lib/server-timing.ts for how to read it.
export const GET = withServerTiming(handleGET)
