import sql from "../db-pool"
import { getPaymentStatus } from "./finance"
import { withActor } from "./actor"
import { sendInvoiceNotice } from "./notices"
import { normalizeId } from "./helpers"
import { owed } from "./refund-owed"
import { causeLineFor, fillNotice, NOTICE_TEMPLATES, REFUND_CAUSES } from "../notice-templates"

/** One customer's share of a mark: how many of their units went, and what
 *  those units were worth on their own. */
export type MarkReduction = {
  customer: string
  unitsRemoved: number
  /** Price per unit on the line these came off. */
  unitPrice: number
  /** Grams per unit, for the ongkir those units were carrying. */
  gramPerUnit: number
}

/**
 * Every customer's invoice total on this event, as it stands right now.
 *
 * Taken before the units come off, so what the reduction costs each of them can
 * be measured rather than guessed: the ongkir their goods were carrying falls
 * with the goods, and only a before-and-after knows by how much once the
 * courier's rounding has had its say.
 */
export async function invoiceTotalsNow(event: string): Promise<Map<string, number>> {
  const rows = await getPaymentStatus(event)
  return new Map(rows.map((s) => [normalizeId(s.customer), s.invoiceTotal]))
}

/**
 * Turn a mark's reductions into refunds, and tell each customer.
 *
 * Called AFTER the units have come off the orders -- and after any parcel-plan
 * reconcile the same change triggered -- because the amount depends on the
 * invoice as it now stands: a reduction owes money only to somebody whose
 * payment has become surplus. Somebody who had not paid simply owes less, and
 * refunding them would invent a debt.
 *
 * The caller passes the totals from before the reduction, so the refund carries
 * the ongkir that left with the goods instead of stranding it as an
 * overpayment for somebody to reconcile by hand.
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
  /** Their invoice totals before the reduction, from invoiceTotalsNow. */
  totalsBefore: Map<string, number>,
  actor?: string | null,
  /** What turned up instead, where a mark knows — a wrong delivery names it. */
  receivedItem?: string,
): Promise<{ customer: string; amount: number; refundId: number }[]> {
  if (reductions.length === 0) return []

  const statuses = await getPaymentStatus(event)
  // Handles are stored with whatever spelling was typed; getPaymentStatus emits
  // them normalized. Compare normalized or match nothing.
  const byCustomer = new Map(statuses.map((s) => [normalizeId(s.customer), s]))

  // Her ongkir rate for this trip, so a reduction's own maximum cost can be
  // worked out without asking the invoice.
  const [rateRow] = (await sql`
    SELECT COALESCE(cwo.ongkos_kirim, 0)::int AS rate
      FROM events e
      JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = e.warehouse_id
      JOIN customers c ON c.id = cwo.customer_id
     WHERE e.name = ${event}
       AND lower(replace(c.instagram_id, '@', '')) = ${normalizeId(reductions[0].customer)}
  `) as unknown as { rate: number }[]
  const ongkirRate = rateRow?.rate ?? 0

  const cause = REFUND_CAUSES.find((c) => c.key === reason)
  const template = NOTICE_TEMPLATES.find((t) => t.key === "inbox_refund_offered")!

  const made: { customer: string; amount: number; refundId: number }[] = []

  for (const r of reductions) {
    const key = normalizeId(r.customer)
    const status = byCustomer.get(key)
    if (!status) continue
    // What the reduction cost her: goods, the ongkir those goods were bearing,
    // and anything the same change moved. Measured, not reconstructed.
    const measured = (totalsBefore.get(key) ?? status.invoiceTotal) - status.invoiceTotal
    // ...but never more than this reduction could possibly have cost on its
    // own. The measurement is a before-and-after on her whole invoice, and
    // marks do not run one at a time: five products marked in the same instant
    // each read an invoice the other four had already reduced, and each claimed
    // the lot. One customer was written five refunds totalling Rp 3.473.000
    // against a surplus of Rp 795.000.
    //
    // The ceiling is this reduction's own goods plus, at most, the ongkir for
    // its own weight. A single mark stays exactly as it was -- the measurement
    // is the smaller number, and the ongkir still comes back with the goods --
    // while concurrent marks can no longer count each other's.
    const ownGoods = r.unitsRemoved * r.unitPrice
    const ownOngkir = ongkirRate * Math.ceil((r.unitsRemoved * r.gramPerUnit) / 1000)
    const cost = Math.min(measured, ownGoods + ownOngkir)
    const amount = owed(cost, status.totalPaid, status.invoiceTotal)
    if (amount <= 0) continue

    const items = `${itemsLabel} × ${r.unitsRemoved}`

    // What she is owed for this trip and this cause once this mark lands, not
    // what this mark alone came to. She is told a running total because a
    // running total is what she will be paid: one refund, grown by each mark,
    // rather than one per product.
    const [openRow] = (await sql`
      SELECT refund_amount::int AS amount, note FROM refunds
       WHERE event = ${event}
         AND lower(replace(customer, '@', '')) = ${key}
         AND reason = ${reason}
         AND status = 'pending'
       ORDER BY id LIMIT 1
    `) as unknown as { amount: number; note: string }[]

    const runningTotal = (openRow?.amount ?? 0) + amount
    const soFar = String(openRow?.note ?? "").split("\n").map((l) => l.trim()).filter(Boolean)
    if (!soFar.includes(items)) soFar.push(items)
    const itemsList = soFar.join("\n")

    const tokens = {
      "{customer}": r.customer,
      "{event}": event,
      "{refundAmount}": `Rp ${new Intl.NumberFormat("id-ID").format(runningTotal)}`,
      "{itemsList}": itemsList,
      "{receivedItem}": receivedItem ?? "",
      "{cause}": "",
    }
    const causeLine = cause
      ? fillNotice(causeLineFor(cause, { items: itemsList, receivedItem }), tokens)
      : ""

    // withActor opens the transaction and stamps app.actor; sendInvoiceNotice
    // writes the refund and the notice inside it. Same shape the invoice
    // notice route uses.
    const { refundId } = await withActor(actor, (tx) => sendInvoiceNotice({
      event,
      customer: r.customer,
      title: fillNotice(template.title, tokens),
      body: fillNotice(template.body, { ...tokens, "{cause}": causeLine }),
      refund: { cause: reason, amount, affectedUnits: r.unitsRemoved, items, mergePending: true },
    }, tx))
    if (refundId) made.push({ customer: r.customer, amount, refundId })
  }

  return made
}
