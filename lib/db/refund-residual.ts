/**
 * How much of what a customer is owed no refund covers yet.
 *
 * Three places need this figure — the detector's reconcile pass, the To-check
 * list, and the Dashboard count — and they must never disagree about it, so it
 * is computed once here rather than written three times in SQL. A disagreement
 * between them is money either paid twice or not at all.
 *
 * Integer rupiah throughout. Never floats: money that rounds is money that
 * argues.
 */


/**
 * What is owed and unrefunded.
 *
 * Two cases look like refunds and are not, and both floor at zero: an
 * underpayment is not a negative refund, and refunds already exceeding the
 * overpayment do not owe money back the other way.
 */
export function uncovered(
  totalPaid: number,
  invoiceTotal: number,
  liveRefundAmounts: number[],
): number {
  const over = totalPaid - invoiceTotal
  if (over <= 0) return 0
  const covered = liveRefundAmounts.reduce((sum, n) => sum + n, 0)
  return Math.max(0, over - covered)
}

/**
 * What one refund row should hold, given the others.
 *
 * Reconciling a row to the WHOLE overpayment would have it claim money a mark's
 * refund already claims, so the row being reconciled is left out of the sum.
 */
export function residualExcluding(
  totalPaid: number,
  invoiceTotal: number,
  liveRefunds: { id: number; amount: number }[],
  excludeId: number,
): number {
  return uncovered(
    totalPaid,
    invoiceTotal,
    liveRefunds.filter((r) => r.id !== excludeId).map((r) => r.amount),
  )
}
