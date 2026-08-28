/**
 * Whether a refund's amount is read from her ledger or from the row.
 *
 * An overpayment describes a balance, and balances move: cindyalyssa_'s
 * Rp 482.000 became Rp 2.000 four days later because she ordered socks on the
 * same trip. While the refund is still being decided, the honest figure is
 * whatever she is overpaid by right now.
 *
 * Everything else is a price, or a decision already made:
 *   - a goods refund is what the item cost, and does not care about her balance
 *   - a deposit is a fixed sum she chose to keep
 *   - a paid or cancelled refund is history
 */
export type LiveRefundFields = { reason: string; status: string }

const LIVE_STATUSES = new Set(["pending", "awaiting_bank_info", "ready_to_refund"])

export function isLiveAmount(row: LiveRefundFields): boolean {
  return row.reason === "overpayment" && LIVE_STATUSES.has(row.status)
}
