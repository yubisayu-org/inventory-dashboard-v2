/**
 * What one customer is owed for units taken off their order.
 *
 * Not the value of the goods. Removing a kilo of goods removes a kilo of
 * ongkir with it -- the invoice bills weight it no longer carries -- and
 * refunding only the price left the difference behind as a stray overpayment
 * for somebody to find in To check. One reduction, one refund.
 *
 * So the caller measures what the reduction actually cost her: her invoice
 * total before it, less her invoice total after. That figure carries the goods,
 * the ongkir the goods were bearing, and any adjustment the same change moved
 * -- exactly, rounding included, with no second guess at which kilo crossed a
 * ceiling.
 *
 * Still capped by surplus. Reducing an UNPAID order lowers what that customer
 * owes; nothing comes back to her, and refunding there would invent a debt. And
 * the cap still keeps an unrelated overpayment out of this refund: the cost is
 * bounded by the reduction, so money she transferred for other reasons stays in
 * To check, where somebody decides what it was for.
 *
 * Integer rupiah. Never floats.
 */
export function owed(
  reductionCost: number,
  totalPaid: number,
  invoiceTotalAfter: number,
): number {
  const cost = Math.max(0, reductionCost)
  if (cost <= 0) return 0
  const surplus = totalPaid - invoiceTotalAfter
  if (surplus <= 0) return 0
  return Math.min(cost, surplus)
}
