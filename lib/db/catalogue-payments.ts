import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { normalizeId } from "./helpers"
import { notifyCustomer } from "./announcements"

/**
 * Payments the customer reports herself, and what became of each one.
 *
 * A reported payment is an ordinary unchecked `payments` row — the same row
 * the shop creates when it records a transfer it has not yet reconciled. It
 * changes no total until someone ticks it, because every invoice sum already
 * filters on `is_checked`.
 */

export type CustomerPaymentStatus = "pending" | "verified" | "rejected"

export interface CustomerPayment {
  id: number
  event: string
  amount: number
  /** Which of the shop's banks she says she sent to. */
  bank: string
  /** The name on her sending account — what the shop looks for in the statement. */
  sender: string
  status: CustomerPaymentStatus
  /** Why it was refused. Empty unless status is "rejected". */
  reason: string
  paidOn: string
}

/** The shop's own banks, as the customer is asked to send to them. */
export interface PayableBank {
  label: string
  number: string
}

function statusOf(row: { is_checked: boolean; rejected_at: Date | null }): CustomerPaymentStatus {
  if (row.rejected_at) return "rejected"
  return row.is_checked ? "verified" : "pending"
}

/** Rounds to a whole rupiah and refuses anything that is not money. */
function cleanAmount(value: unknown): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n <= 0) throw new Error("Jumlah transfer tidak valid")
  // A claim larger than any plausible order is a typo or a probe, and either
  // way it should not become a row someone has to hunt down later.
  if (n > 500_000_000) throw new Error("Jumlah transfer terlalu besar")
  return n
}

/**
 * Where the money is meant to go.
 *
 * Read from business_profile rather than typed into the catalogue, so the
 * numbers she is shown cannot drift from the ones the shop publishes
 * elsewhere. Each line is "<bank name> <account number>", the shape the
 * profile already stores.
 */
export async function getPayableBanks(
  db: DBExecutor = sql,
): Promise<{ holder: string; banks: PayableBank[] }> {
  const [row] = await db<{ bank_account_holder: string; bank_account_lines: string }[]>`
    SELECT bank_account_holder, bank_account_lines FROM business_profile ORDER BY id LIMIT 1
  `
  if (!row) return { holder: "", banks: [] }

  const banks: PayableBank[] = []
  for (const line of String(row.bank_account_lines ?? "").split("\n")) {
    const text = line.trim()
    if (!text) continue
    // The account number is the trailing run of digits; everything before it
    // names the bank. Written this way because the profile is free text and a
    // bank name can itself contain digits ("Bank Jago (Artos)").
    const match = /^(.*?)\s*([0-9][0-9\s-]{5,})$/.exec(text)
    if (!match) continue
    banks.push({ label: match[1].trim(), number: match[2].replace(/[\s-]/g, "") })
  }
  return { holder: String(row.bank_account_holder ?? ""), banks }
}

/** Her own reported payments, newest last so the history reads forwards. */
export async function getCustomerPayments(
  handle: string,
  db: DBExecutor = sql,
): Promise<CustomerPayment[]> {
  const key = normalizeId(handle)
  const rows = await db<
    {
      id: number
      event: string
      amount: string
      account: string
      remarks: string
      is_checked: boolean
      rejected_at: Date | null
      reject_reason: string
      pay_date: Date | null
      created_at: Date
    }[]
  >`
    SELECT id, event, amount, account, remarks, is_checked, rejected_at, reject_reason,
           pay_date, created_at
      FROM payments
     WHERE lower(replace(customer, '@', '')) = ${key}
       AND kind = 'deposit'
     ORDER BY created_at, id
  `
  return rows.map((r): CustomerPayment => ({
    id: r.id,
    event: r.event,
    amount: Number(r.amount),
    bank: r.account ?? "",
    sender: r.remarks ?? "",
    status: statusOf(r),
    reason: r.reject_reason ?? "",
    paidOn: (r.pay_date ?? r.created_at).toISOString().slice(0, 10),
  }))
}

/**
 * Record what she says she transferred.
 *
 * The customer is the session's, never the request's. `is_checked` is not
 * granted to catalogue_public at all, so the column default — false — is the
 * only value this can produce: a claim, not a fact.
 *
 * There is deliberately no cap on how many claims one event may carry. A
 * deposit today and the rest on payday is ordinary, and blocking the second
 * one stops her telling the shop rather than stopping her transferring.
 */
export async function submitCustomerPayment(
  input: { handle: string; event: string; amount: unknown; bank: string; sender: string },
  db: DBExecutor = sql,
): Promise<{ id: number; amount: number }> {
  const amount = cleanAmount(input.amount)
  const bank = String(input.bank ?? "").trim()
  const sender = String(input.sender ?? "").trim()
  if (!bank) throw new Error("Pilih bank tujuan transfer")
  if (!sender) throw new Error("Isi nama rekening pengirim")
  if (sender.length > 120) throw new Error("Nama rekening terlalu panjang")

  // The trip has to be one she actually ordered on. Without this the endpoint
  // would happily file a payment against any event name a caller invented.
  const [order] = await db<{ customer: string }[]>`
    SELECT customer FROM orders
     WHERE event = ${input.event}
       AND lower(replace(customer, '@', '')) = ${normalizeId(input.handle)}
     LIMIT 1
  `
  if (!order) throw new Error("Order tidak ditemukan")

  const [row] = await db<{ id: number }[]>`
    INSERT INTO payments (event, customer, amount, account, remarks, pay_date, kind)
    VALUES (${input.event}, ${order.customer}, ${amount}, ${bank}, ${sender},
            CURRENT_DATE, 'deposit')
    RETURNING id
  `
  return { id: row.id, amount }
}

/**
 * The shop could not find the money, and says so.
 *
 * The row stays exactly as she sent it. Editing it in place would leave the
 * reason sitting on figures it was never about — it would read as though the
 * corrected version had been refused.
 */
export async function rejectCustomerPayment(
  id: number,
  reason: string,
  db: DBExecutor = sql,
): Promise<void> {
  const text = String(reason ?? "").trim()
  if (!text) throw new Error("Alasan wajib diisi")

  const [row] = await db<{ customer: string; event: string; amount: string }[]>`
    UPDATE payments
       SET rejected_at = NOW(), reject_reason = ${text.slice(0, 300)}, is_checked = false
     WHERE id = ${id} AND rejected_at IS NULL
    RETURNING customer, event, amount
  `
  if (!row) throw new Error("Pembayaran tidak ditemukan atau sudah ditolak")

  const amount = Number(row.amount).toLocaleString("id-ID")
  await notifyCustomer(row.customer, {
    title: "We could not confirm that payment",
    body: `${text} Send it again with the right details and we will look straight away. `
      + `(${row.event}, Rp ${amount})`,
  }, db)
}

/** Undo a refusal, for when the money turns up after all. */
export async function unrejectCustomerPayment(id: number, db: DBExecutor = sql): Promise<void> {
  await db`
    UPDATE payments SET rejected_at = NULL, reject_reason = '' WHERE id = ${id}
  `
}
