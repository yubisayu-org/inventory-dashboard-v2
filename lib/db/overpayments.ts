import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { getPaymentStatus } from "./finance"
import { normalizeId } from "./helpers"
import { isLiveAmount } from "./live-refund"
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
type Cover = { total: number; hasLive: boolean }

async function refundedByPair(db: DBExecutor): Promise<Map<string, Cover>> {
  const rows = await db<{ event: string; cust_key: string; total: string; reason: string; status: string }[]>`
    SELECT event,
           lower(replace(customer, '@', '')) AS cust_key,
           refund_amount AS total,
           reason,
           status
      FROM refunds
     WHERE status <> 'cancelled'
  `
  const m = new Map<string, Cover>()
  for (const r of rows) {
    const key = `${r.event}|${r.cust_key}`
    const cur = m.get(key) ?? { total: 0, hasLive: false }
    // A live refund's stored figure is decorative -- its amount is read from
    // her balance. Summing it would make a covered overpayment look uncovered
    // and offer the same money a second time, so its presence is the cover.
    if (isLiveAmount({ reason: r.reason, status: r.status })) cur.hasLive = true
    else cur.total += Number(r.total)
    m.set(key, cur)
  }
  return m
}

export async function listOverpaymentsToCheck(
  db: DBExecutor = sql,
): Promise<OverpaymentToCheck[]> {
  const [statuses, refunded] = await Promise.all([getPaymentStatus(), refundedByPair(db)])

  const out: OverpaymentToCheck[] = []
  for (const s of statuses) {
    const cover = refunded.get(`${s.event}|${normalizeId(s.customer)}`)
    // Somebody is already dealing with this one, and it is worth whatever she
    // is overpaid by -- there is no remainder to check.
    if (cover?.hasLive) continue
    const refundedSoFar = cover?.total ?? 0
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
