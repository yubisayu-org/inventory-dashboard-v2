import { getPaymentStatus } from "./finance"
import { withActor } from "./actor"
import { sendInvoiceNotice } from "./notices"
import { normalizeId } from "./helpers"
import { owed } from "./refund-owed"
import { fillNotice, NOTICE_TEMPLATES, REFUND_CAUSES } from "../notice-templates"

/** One customer's share of a mark: how many of their units went, and at what price. */
export type MarkReduction = {
  customer: string
  unitsRemoved: number
  unitPrice: number
}

/**
 * Turn a mark's reductions into refunds, and tell each customer.
 *
 * Called AFTER the units have come off the orders, because the amount depends
 * on the invoice as it now stands: a reduction owes money only to somebody
 * whose payment has become surplus. Somebody who had not paid simply owes less,
 * and refunding them would invent a debt.
 *
 * The refund and the notice are one action — sendInvoiceNotice writes both in a
 * single transaction, because a refund nobody is told about is a promise nobody
 * made, and a notice without a refund promises money the system has no record
 * of.
 */
export async function refundForReduction(
  event: string,
  reason: string,
  itemsLabel: string,
  reductions: MarkReduction[],
  actor?: string | null,
): Promise<{ customer: string; amount: number; refundId: number }[]> {
  if (reductions.length === 0) return []

  const statuses = await getPaymentStatus(event)
  // Handles are stored with whatever spelling was typed; getPaymentStatus emits
  // them normalized. Compare normalized or match nothing.
  const byCustomer = new Map(statuses.map((s) => [normalizeId(s.customer), s]))

  const cause = REFUND_CAUSES.find((c) => c.key === reason)
  const template = NOTICE_TEMPLATES.find((t) => t.key === "inbox_refund_offered")!

  const made: { customer: string; amount: number; refundId: number }[] = []

  for (const r of reductions) {
    const status = byCustomer.get(normalizeId(r.customer))
    if (!status) continue
    const amount = owed(r.unitsRemoved, r.unitPrice, status.totalPaid, status.invoiceTotal)
    if (amount <= 0) continue

    const items = `${itemsLabel} × ${r.unitsRemoved}`
    const tokens = {
      "{customer}": r.customer,
      "{event}": event,
      "{refundAmount}": `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`,
      "{itemsList}": items,
      "{cause}": "",
    }
    const causeLine = cause ? fillNotice(cause.line, tokens) : ""

    // withActor opens the transaction and stamps app.actor; sendInvoiceNotice
    // writes the refund and the notice inside it. Same shape the invoice
    // notice route uses.
    const { refundId } = await withActor(actor, (tx) => sendInvoiceNotice({
      event,
      customer: r.customer,
      title: fillNotice(template.title, tokens),
      body: fillNotice(template.body, { ...tokens, "{cause}": causeLine }),
      refund: { cause: reason, amount, affectedUnits: r.unitsRemoved, items },
    }, tx))
    if (refundId) made.push({ customer: r.customer, amount, refundId })
  }

  return made
}
