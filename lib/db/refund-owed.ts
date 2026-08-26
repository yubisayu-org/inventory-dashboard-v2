/**
 * What one customer is owed for units taken off their order.
 *
 * Not simply the value of what was removed. Reducing an UNPAID order lowers
 * what that customer owes — nothing comes back to them, and refunding there
 * would invent a debt. So the value of the removed units is capped by how much
 * of their money is actually surplus once the invoice has fallen.
 *
 * Integer rupiah. Never floats.
 */
export function owed(
  unitsRemoved: number,
  unitPrice: number,
  totalPaid: number,
  invoiceTotalAfter: number,
): number {
  const value = Math.max(0, unitsRemoved) * Math.max(0, unitPrice)
  if (value <= 0) return 0
  const surplus = totalPaid - invoiceTotalAfter
  if (surplus <= 0) return 0
  return Math.min(value, surplus)
}
