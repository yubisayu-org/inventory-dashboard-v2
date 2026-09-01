import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { normalizeId } from "./helpers"

// A signed-in customer's balance.
//
// The line items and per-event invoices come from getPublicInvoiceForCustomer
// on the invoice_reader role — the same query the public recap site uses — so
// the catalogue shows the shop's own invoice rather than a second rendering of
// it. This file is what is left: the roll-up across every event.

export type CustomerBalance = {
  invoiceCount: number
  totalInvoiced: number
  totalOutstanding: number
}

/** A credit she chose to keep, and the trip it came from. */
export type HeldCredit = {
  event: string
  amount: number
}

/**
 * What this customer has been invoiced and what is still outstanding.
 *
 * Read from customer_invoice_summary, which aggregates orders, payments,
 * adjustments and ongkir into three numbers — so the public role reaches a
 * balance without payments or adjustments being readable at all.
 */
export async function getCustomerBalance(
  instagramId: string,
  db: DBExecutor = sql,
): Promise<CustomerBalance> {
  const key = normalizeId(instagramId)
  const [row] = await db<
    { invoice_count: string; total_invoiced: string; total_outstanding: string }[]
  >`
    SELECT invoice_count, total_invoiced, total_outstanding
      FROM customer_invoice_summary WHERE cust_key = ${key}
  `
  // A customer with no invoices has no row, which is a zero balance rather
  // than an error.
  return {
    invoiceCount: Number(row?.invoice_count ?? 0),
    totalInvoiced: Number(row?.total_invoiced ?? 0),
    totalOutstanding: Number(row?.total_outstanding ?? 0),
  }
}

/**
 * Credits she has chosen to keep for a future order.
 *
 * Her card already says "Rp 209.400 is waiting on your account" — but it says
 * it on the order the money came FROM, not the one she will spend it on. With
 * two or three she has to find them among unrelated orders and add them up.
 * This is the same money in one place, not new money.
 *
 * The predicate is isCreditPromised's, and deliberately not a copy of
 * allHeldDeposits: that one scans every refund in the shop to build a map for
 * the Invoice list, which is the wrong shape for one customer opening her own
 * page. Same rule, scoped to her.
 *
 * Every column here is one catalogue_public may select. It reads created_at
 * rather than updated_at — "how long has this sat there" is the shop's
 * question, asked on the Refunds screen, and updated_at is not granted to this
 * role.
 */
export async function getHeldCredits(
  instagramId: string,
  db: DBExecutor = sql,
): Promise<HeldCredit[]> {
  const key = normalizeId(instagramId)
  const rows = await db<{ event: string; refund_amount: string }[]>`
    SELECT event, refund_amount
      FROM refunds
     WHERE lower(replace(customer, '@', '')) = ${key}
       AND status = 'applied_to_next_order'
       AND refund_amount > 0
     ORDER BY created_at, id
  `
  return rows.map((r) => ({ event: r.event, amount: Number(r.refund_amount) }))
}
