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
 * The difference is already in the row: a settled credit leaves nothing owed.
 *
 * It used to test `appliedCreditAmount` as well, because a partly applied
 * credit dropped back to `pending` and this combination could not occur. It can
 * now — spending part of a deposit leaves the rest a deposit — and a row with
 * money still on it is still a promise, whether or not some of it has already
 * been spent.
 */
export interface CreditPromiseFields {
  status: string
  /** What is still owed back. */
  refundAmount: number
  /** What has already been moved onto another order. */
  appliedCreditAmount: number
}

export function isCreditPromised(row: CreditPromiseFields): boolean {
  return row.status === "applied_to_next_order" && row.refundAmount > 0
}
