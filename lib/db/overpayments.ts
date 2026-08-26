import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { getPaymentStatus } from "./finance"
import { normalizeId } from "./helpers"
import { uncovered } from "./refund-residual"

/**
 * Money a customer is owed that no refund covers yet.
 *
 * Not refunds. A row here is an observation — the arithmetic noticing a gap —
 * and becomes a refund only when somebody decides it is worth sending. That
 * separation is the point: Pending is a to-do list, every row in it money you
 * have decided to send, and a Rp 2.000 shipping rounding is not a task.
 */
export type OverpaymentToCheck = {
  event: string
  customer: string
  totalPaid: number
  invoiceTotal: number
  /** What live refunds already claim for this pair. */
  refundedSoFar: number
  uncovered: number
}

/**
 * Live refund totals per (event, customer), keyed on the NORMALIZED handle.
 *
 * getPaymentStatus emits the normalized handle; refunds.customer holds whatever
 * was typed — "@Qkooy" and "qkooy" are the same person and the same debt.
 * Keying on the raw value matches nothing, and the failure is silent and points
 * the wrong way: every covered overpayment looks uncovered.
 */
async function refundedByPair(db: DBExecutor): Promise<Map<string, number>> {
  const rows = await db<{ event: string; cust_key: string; total: string }[]>`
    SELECT event,
           lower(replace(customer, '@', '')) AS cust_key,
           SUM(refund_amount) AS total
      FROM refunds
     WHERE status <> 'cancelled'
     GROUP BY event, lower(replace(customer, '@', ''))
  `
  const m = new Map<string, number>()
  for (const r of rows) m.set(`${r.event}|${r.cust_key}`, Number(r.total))
  return m
}

export async function listOverpaymentsToCheck(
  db: DBExecutor = sql,
): Promise<OverpaymentToCheck[]> {
  const [statuses, refunded] = await Promise.all([getPaymentStatus(), refundedByPair(db)])

  const out: OverpaymentToCheck[] = []
  for (const s of statuses) {
    const refundedSoFar = refunded.get(`${s.event}|${normalizeId(s.customer)}`) ?? 0
    const gap = uncovered(s.totalPaid, s.invoiceTotal, [refundedSoFar])
    if (gap <= 0) continue
    out.push({
      event: s.event,
      customer: s.customer,
      totalPaid: s.totalPaid,
      invoiceTotal: s.invoiceTotal,
      refundedSoFar,
      uncovered: gap,
    })
  }
  // Largest first: that is the order they get worked.
  return out.sort((a, b) => b.uncovered - a.uncovered)
}

/**
 * Promote one row to a refund.
 *
 * Recomputes the figure rather than trusting one sent from a browser — the
 * list may be minutes old, and the amount is money.
 */
export async function createRefundFromOverpayment(
  event: string,
  customer: string,
  actor?: string | null,
): Promise<{ id: number; amount: number }> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`

    const rows = await listOverpaymentsToCheck(tx)
    const want = normalizeId(customer)
    const row = rows.find((r) => r.event === event && normalizeId(r.customer) === want)
    if (!row) throw new Error("Nothing is uncovered for this customer on this trip")

    const [made] = await tx<{ id: number }[]>`
      INSERT INTO refunds (event, customer, reason, refund_amount, note)
      VALUES (${event}, ${customer}, 'overpayment', ${row.uncovered},
              ${`Paid Rp ${row.totalPaid} of Rp ${row.invoiceTotal}`})
      RETURNING id
    `
    return { id: made.id, amount: row.uncovered }
  })
}
