import sql from "../db-pool"
import { withActor } from "./actor"
import { appendExcessPurchase } from "./orders"
import { invoiceTotalsNow, refundForReduction } from "./mark-refunds"

/**
 * Goods that came back after she had them.
 *
 * A quality refund used to move money alone: the invoice went on billing the
 * returned item, so paying the refund out — which writes a negative payment —
 * left her owing for something sitting on the shop's shelf.
 *
 * Cancelling the line was not the answer. Those units really did ship, and
 * writing unit_ship down would offer them again on the Packing List while the
 * parcel's own record still said they left. So the return is recorded on the
 * line as `unit_returned`, and every place that turns units into money or
 * weight bills `unit - unit_returned`: the line keeps saying she bought five,
 * the invoice charges for four, and the courier's record stays true.
 *
 * The refund is priced the way a cancellation is — her invoice before against
 * her invoice after — so the ongkir those goods were carrying comes back with
 * them, and somebody who has not paid simply owes less instead of being handed
 * a refund that invents a debt.
 */
export async function recordReturnedUnits(
  input: {
    event: string
    customer: string
    /** One of REFUND_REASONS — why it came back. */
    reason: string
    /** Whether it can be sold again, which is what Inventory needs to know. */
    goods: "returned" | "returned_unsellable"
    lines: { orderId: number; qty: number }[],
  },
  actor?: string | null,
): Promise<{ customer: string; amount: number; refundId: number }[]> {
  const wanted = input.lines.filter((l) => l.qty > 0)
  if (wanted.length === 0) return []

  const rows = await sql<
    { id: number; customer: string; unit: number; unit_returned: number; unit_price: number; gram: number; product_name: string }[]
  >`
    SELECT o.id, o.customer, o.unit, COALESCE(o.unit_returned, 0) AS unit_returned,
           COALESCE(o.unit_price, 0) AS unit_price, COALESCE(p.gram, 0) AS gram,
           p.name AS product_name
      FROM orders o JOIN products p ON p.id = o.product_id
     WHERE o.id = ANY(${wanted.map((l) => l.orderId)})
       AND o.event = ${input.event}
  `
  const byId = new Map(rows.map((r) => [r.id, r]))

  // Before anything moves: the refund is the difference this makes to her
  // bill, and only a before-and-after knows what the courier's rounding did to
  // the ongkir on the way down.
  const totalsBefore = await invoiceTotalsNow(input.event)

  const reductions: { customer: string; unitsRemoved: number; unitPrice: number; gramPerUnit: number }[] = []
  const items: string[] = []

  await withActor(actor, async (tx) => {
    for (const line of wanted) {
      const row = byId.get(line.orderId)
      if (!row) throw new Error("Order not found")

      // She cannot send back more than she has. Anything else is a typo, and
      // a typo here writes money off an invoice.
      const room = row.unit - row.unit_returned
      if (line.qty > room) {
        throw new Error(
          `${row.product_name}: only ${room} unit${room === 1 ? "" : "s"} can still be returned`,
        )
      }

      await tx`
        UPDATE orders
           SET unit_returned = COALESCE(unit_returned, 0) + ${line.qty}, updated_at = NOW()
         WHERE id = ${line.orderId}
      `

      // Back on the shelf, sellable or not — the books have to know a unit
      // exists that no order is claiming any more.
      await appendExcessPurchase(
        [{ event: input.event, items: row.product_name, unitBuy: line.qty, receipt: "", reason: input.goods }],
        tx,
      )

      reductions.push({
        customer: row.customer,
        unitsRemoved: line.qty,
        unitPrice: row.unit_price,
        gramPerUnit: row.gram,
      })
      items.push(`${row.product_name} × ${line.qty}`)
    }
  })

  // Priced after the units are off, because what she is owed depends on the
  // invoice as it now stands. Same function every mark uses.
  return refundForReduction(
    input.event,
    input.reason,
    items.join("\n"),
    reductions,
    totalsBefore,
    actor,
  )
}
