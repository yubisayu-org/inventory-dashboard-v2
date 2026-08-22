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
