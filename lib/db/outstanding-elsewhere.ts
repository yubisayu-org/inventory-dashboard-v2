import { getPaymentStatus } from "./finance"
import { normalizeId } from "./helpers"

/** A trip this customer still owes money on. */
export type OutstandingTrip = { event: string; amount: number }

/**
 * Where else this customer owes money.
 *
 * Refunds are per trip, so somebody can be owed on one and outstanding on
 * another and nothing on the row says so — you have to already know. Marks now
 * raise refunds without being asked, so that knowledge is less likely to be in
 * anyone's head when the row appears.
 *
 * The trip being refunded is excluded: applying a refund as credit against the
 * same invoice it came from just moves the money in a circle.
 *
 * Largest first, because that is the one worth clearing.
 */
export async function outstandingElsewhere(
  customer: string,
  excludeEvent: string,
): Promise<OutstandingTrip[]> {
  // Her trips only, and only the ones with something on them: unscoped this
  // aggregates every customer against every trip, and three of those rows are
  // hers.
  const statuses = await getPaymentStatus(undefined, { customer, only: "outstanding" })
  return statuses
    .filter((s) => s.event !== excludeEvent)
    .map((s) => ({ event: s.event, amount: s.outstanding }))
    .sort((a, b) => b.amount - a.amount)
}

/**
 * Every customer's outstanding trips, keyed by normalized handle.
 *
 * One pass for a whole page. Looking each row up on its own would re-aggregate
 * every invoice in the shop once per refund, and the refunds list is long.
 *
 * Nothing is excluded here — the caller knows which trip its row is about and
 * filters that one out.
 */
export async function outstandingByCustomer(): Promise<Record<string, OutstandingTrip[]>> {
  // 112 pairs of 3,713 owe anything, and the rest were read only to be dropped
  // by the line below.
  const statuses = await getPaymentStatus(undefined, { only: "outstanding" })
  const out: Record<string, OutstandingTrip[]> = {}
  for (const s of statuses) {
    if (s.outstanding <= 0) continue
    const key = normalizeId(s.customer)
    ;(out[key] ??= []).push({ event: s.event, amount: s.outstanding })
  }
  for (const key of Object.keys(out)) out[key].sort((a, b) => b.amount - a.amount)
  return out
}
