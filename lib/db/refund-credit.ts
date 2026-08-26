/**
 * Telling a promised credit from a settled one.
 *
 * Two different things end up at status `applied_to_next_order`:
 *
 *   chooseRefundCredit  — the customer picks "keep it on my account" on her own
 *                         refund card. Moves no money, on purpose: which future
 *                         order it lands on is the shop's decision, made when
 *                         that order exists.
 *   applyRefundAsCredit — the shop actually moves it. Writes a credit payment
 *                         against the old trip and consumes the amount.
 *
 * Only the second is finished. The first is money still owed with nowhere yet
 * to put it, and filing it as done is what stranded it: closed for editing, so
 * when the customer's next order finally appeared there was no way left to
 * apply it.
 *
 * The difference is already in the row — a settled credit has been consumed
 * (`appliedCreditAmount`) and leaves nothing owed; a promise has neither.
 */
export interface CreditPromiseFields {
  status: string
  /** What is still owed back. */
  refundAmount: number
  /** What has already been moved onto another order. */
  appliedCreditAmount: number
}

export function isCreditPromised(row: CreditPromiseFields): boolean {
  return row.status === "applied_to_next_order"
    && row.refundAmount > 0
    && row.appliedCreditAmount <= 0
}
