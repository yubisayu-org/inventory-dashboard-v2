import sql from "../db-pool"
import { normalizeId } from "./helpers"
import { isCreditPromised } from "./refund-credit"

/** A credit she is holding, and where it came from. */
export type HeldDeposit = {
  refundId: number
  /** The trip the money was overpaid on. */
  fromEvent: string
  amount: number
  /** When it was set aside, for the banner to say how long it has sat there. */
  since: string
}

/**
 * What a customer is holding that nobody has spent yet.
 *
 * She picks "keep it on my account" and the refund is filed with the money
 * still on it: no payment written, because which future order it lands on is
 * the shop's decision, made when that order exists. Nothing then reminds
 * anybody. Her next invoice is billed in full while her own money sits two
 * screens away on the Refunds page.
 *
 * A promise, not a settled credit -- the difference is already on the row, and
 * isCreditPromised is the same predicate the Refunds screen uses to label one.
 * A credit that has been applied has a payment against it and nothing owing.
 */
export async function heldDeposits(customer: string): Promise<HeldDeposit[]> {
  return (await allHeldDeposits()).get(normalizeId(customer)) ?? []
}

/**
 * Everyone holding one, keyed by normalized handle.
 *
 * One query for a whole page. The Invoice list marks the customers who hold a
 * deposit, and asking per row would turn one cheap read into one per customer
 * on screen -- the same rule the hit-and-run marks follow.
 */
export async function allHeldDeposits(): Promise<Map<string, HeldDeposit[]>> {
  const rows = (await sql`
    SELECT r.id, r.event, r.status, r.refund_amount::int AS refund_amount, r.updated_at,
           lower(replace(r.customer, '@', '')) AS cust,
           (SELECT COALESCE(SUM(p.amount), 0)::int FROM payments p
             WHERE p.refund_id = r.id AND p.kind = 'credit' AND p.amount > 0) AS applied_credit_amount
      FROM refunds r
     WHERE r.status = 'applied_to_next_order'
       AND r.refund_amount > 0
     ORDER BY r.updated_at ASC
  `) as unknown as {
    id: number; event: string; status: string; cust: string
    refund_amount: number; applied_credit_amount: number; updated_at: Date | null
  }[]

  const out = new Map<string, HeldDeposit[]>()
  for (const r of rows) {
    if (!isCreditPromised({
      status: r.status,
      refundAmount: r.refund_amount,
      appliedCreditAmount: r.applied_credit_amount,
    })) continue
    const list = out.get(r.cust) ?? []
    list.push({
      refundId: r.id,
      fromEvent: r.event,
      amount: r.refund_amount,
      since: r.updated_at ? r.updated_at.toISOString().slice(0, 10) : "",
    })
    out.set(r.cust, list)
  }
  return out
}
