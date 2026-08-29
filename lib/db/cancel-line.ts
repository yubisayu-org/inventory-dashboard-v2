import sql from "../db-pool"
import { withActor } from "./actor"
import { cancelOrderUnits } from "./orders"
import { notifyCustomer } from "./announcements"
import { reconcileParcelPlan } from "./parcel-plan"
import { invoiceTotalsNow, refundForReduction } from "./mark-refunds"
import { NOTICE_TEMPLATES, fillNotice } from "../notice-templates"

/**
 * Cancel part or all of one invoice line, the way a mark cancels one.
 *
 * The invoice's own Cancel used to stop at the order: the line shrank, her
 * total fell, and if she had already paid, the surplus sat waiting on the
 * Refunds page for somebody to notice it and promote it by hand. Every other
 * way of taking goods off an order -- sold out, broken, missing, wrong -- files
 * the refund itself. This one now does too, through the same function, so the
 * amount is measured the same way: what her invoice actually fell by, capped by
 * what this line could have cost, which is how the ongkir riding on the removed
 * goods comes back with them instead of stranding as an overpayment.
 *
 * The order moves in its own transaction, and the refund is priced after it
 * commits -- what she is owed depends on the invoice as it now stands, and the
 * parcel plan has to settle first because fewer units is a different parcel.
 * Same shape recordNotReceived uses.
 *
 * She hears about it exactly once. A refund's notice already names what came
 * off and what is coming back, so the plain cancellation notice is sent only
 * when there is no refund to send -- an unpaid order simply costs less, and
 * that is still news.
 */
export async function cancelOrderLineForCustomer(
  data: {
    orderId: number
    qty: number
    event: string
    productName: string
    receipt?: string
    stamp?: string
  },
  actor?: string | null,
): Promise<{
  excessUnits: number
  remainingUnit: number
  refunds: { customer: string; amount: number; refundId: number }[]
}> {
  const [order] = (await sql`
    SELECT o.customer, COALESCE(o.unit_price, 0)::int AS unit_price,
           COALESCE(p.gram, 0)::int AS gram
      FROM orders o JOIN products p ON p.id = o.product_id
     WHERE o.id = ${data.orderId}
  `) as unknown as { customer: string; unit_price: number; gram: number }[]
  if (!order) throw new Error("Order not found")

  // Before anything moves. The refund is the difference this makes to her bill,
  // and only a before-and-after knows what the courier's rounding did to the
  // ongkir on the way down.
  const totalsBefore = await invoiceTotalsNow(data.event)

  const result = await withActor(actor, (tx) => cancelOrderUnits(data, tx))

  // Fewer units is a different parcel whether or not anyone is splitting one.
  // Before the refund is priced, not after: it moves the invoice too.
  await reconcileParcelPlan(order.customer, data.event)

  const refunds = await refundForReduction(
    data.event,
    "customer_cancelled",
    data.productName,
    [{
      customer: order.customer,
      unitsRemoved: data.qty,
      unitPrice: order.unit_price,
      gramPerUnit: order.gram,
    }],
    totalsBefore,
    actor,
  )

  if (refunds.length === 0) {
    const template = NOTICE_TEMPLATES.find((t) => t.key === "inbox_order_cancelled")!
    const money = order.unit_price * data.qty
    const tokens = {
      "{customer}": order.customer,
      "{event}": data.event,
      "{itemsList}": `- ${data.productName} × ${data.qty}`
        + (money > 0 ? ` — Rp ${new Intl.NumberFormat("id-ID").format(money)}` : ""),
      "{amount}": `Rp ${new Intl.NumberFormat("id-ID").format(money)}`,
    }
    await withActor(actor, (tx) => notifyCustomer(order.customer, {
      title: fillNotice(template.title, tokens),
      body: fillNotice(template.body, tokens),
    }, tx))
  }

  return { ...result, refunds }
}
