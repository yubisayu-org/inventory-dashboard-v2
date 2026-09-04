import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { normalizeId } from "./helpers"

/**
 * The one check that stands between a transfer and being counted twice.
 *
 * A payment can be written down more than once in three ways: staff records
 * what the customer already claimed, staff records the same transfer twice, or
 * she claims it twice herself. All three end as two rows for one transfer, so
 * all three are found by asking the same question before a row is created or
 * ticked — which works because a claim is not a separate thing, it is a
 * payments row nobody has ticked yet.
 *
 * It warns and never blocks. Measured against the shop's own history, two
 * transfers that look identical are usually two real transfers; only the bank
 * statement can settle which, and that is not something code can read.
 */

/** How far apart two rows may sit and still be one transfer. Three days: on
 *  the shop's history, widening it to a week finds nothing further. */
export const DUPLICATE_WINDOW_DAYS = 3

export interface DuplicatePayment {
  id: number
  amount: number
  /** ISO date, from pay_date where there is one. */
  payDate: string
  account: string
  /** The sending name, which is what a person recognises the row by. */
  remarks: string
  isChecked: boolean
  /** 'customer' means she filed it herself — the case where ticking hers is
   *  the right answer rather than saving a second row. */
  reportedBy: "shop" | "customer"
}

/**
 * A row that looks like the same money as the one described.
 *
 * Matched on customer, trip, exact amount and three days. The trip is part of
 * it deliberately: without it the shop's real history throws up nearly three
 * times as many warnings, and the ones it adds are genuine — one customer paid
 * Rp 2.000 against three different trips in a single day. The account is not
 * part of it, because she may transfer one day and scan the QR the next; the
 * amount is what makes it the same money.
 *
 * A refused row is not a candidate. It took nothing, so it stands in nobody's
 * way.
 */
export async function findDuplicatePayment(
  input: {
    customer: string
    event: string
    amount: number
    /** The date on the row being written; today when it has none. */
    payDate?: string | null
    /** The row being ticked, which must not match itself. */
    excludeId?: number
  },
  db: DBExecutor = sql,
): Promise<DuplicatePayment | null> {
  if (!input.event || !(input.amount > 0)) return null

  const [row] = await db<
    {
      id: number
      amount: string
      pay_date: Date | null
      created_at: Date
      account: string
      remarks: string
      is_checked: boolean
      reported_by: string
    }[]
  >`
    SELECT id, amount, pay_date, created_at, account, remarks, is_checked, reported_by
      FROM payments
     WHERE lower(replace(customer, '@', '')) = ${normalizeId(input.customer)}
       AND event = ${input.event}
       AND amount = ${input.amount}
       AND kind = 'deposit'
       AND rejected_at IS NULL
       AND id <> ${input.excludeId ?? 0}
       AND abs(coalesce(pay_date, created_at::date)
               - ${input.payDate || null}::date) <= ${DUPLICATE_WINDOW_DAYS}
     -- A checked row is the stronger warning: that one is already counted
     -- against her invoice. Failing that, the most recent.
     ORDER BY is_checked DESC, id DESC
     LIMIT 1
  `
  if (!row) return null

  return {
    id: row.id,
    amount: Number(row.amount),
    payDate: (row.pay_date ?? row.created_at).toISOString().slice(0, 10),
    account: row.account ?? "",
    remarks: row.remarks ?? "",
    isChecked: row.is_checked,
    reportedBy: row.reported_by === "customer" ? "customer" : "shop",
  }
}

/**
 * The same question asked of a row that already exists, for the moment it is
 * about to be ticked.
 *
 * The tick is where a claim stops being a claim and starts counting against
 * her invoice, so it is the last place the question can be asked — and since
 * only an owner may tick, it lands on the one role that can complete a double.
 */
export async function findDuplicateForRow(
  id: number,
  db: DBExecutor = sql,
): Promise<DuplicatePayment | null> {
  const [row] = await db<
    { customer: string; event: string; amount: string; pay_date: Date | null; created_at: Date }[]
  >`
    SELECT customer, event, amount, pay_date, created_at
      FROM payments WHERE id = ${id} AND kind = 'deposit'
  `
  if (!row) return null

  return findDuplicatePayment({
    customer: row.customer,
    event: row.event,
    amount: Number(row.amount),
    payDate: (row.pay_date ?? row.created_at).toISOString().slice(0, 10),
    excludeId: id,
  }, db)
}
