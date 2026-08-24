import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { normalizeId } from "./helpers"

/**
 * Money owed back, from the customer's side.
 *
 * She sees what is coming back and says how she wants it: kept on her account
 * for the next order, or transferred to her bank. Nothing here decides that a
 * refund exists — that is the shop's arithmetic, reconciled by
 * materializeOverpaymentRefunds and by whoever refunds a lost parcel.
 *
 * Reads run on the least-privilege role; writes run on the main pool, because
 * a status transition is a rule rather than a column. Every one is scoped to
 * her own handle and to the states a customer is allowed to move a refund out
 * of — never `refunded`, which is a transfer that has already happened.
 */

export type RefundChoice = "credit" | "bank"

export interface CustomerRefund {
  id: number
  event: string
  amount: number
  /** Why the money is coming back — the shop's own vocabulary. */
  reason: string
  status: string
  /** The shop's note, which names the items when the cause was about items. */
  note: string
  /** Where it is going, masked: she typed it, she does not need it read back. */
  bank: string
  accountMask: string
  accountHolder: string
  /** Set once the transfer has gone. */
  reference: string
  createdAt: string
}

/** She should see enough to recognise the account, and no more. */
function maskAccount(number: string): string {
  const digits = String(number ?? "").replace(/\s/g, "")
  if (!digits) return ""
  if (digits.length <= 4) return digits
  return `${"•".repeat(Math.max(2, digits.length - 4))}${digits.slice(-4)}`
}

/** The states a customer may still move a refund out of. */
const OPEN_STATUSES = ["pending", "awaiting_bank_info", "ready_to_refund", "applied_to_next_order"]

export async function getCustomerRefunds(
  handle: string,
  db: DBExecutor = sql,
): Promise<CustomerRefund[]> {
  const key = normalizeId(handle)
  const rows = await db<
    {
      id: number
      event: string
      refund_amount: number
      reason: string
      status: string
      note: string
      bank_name: string
      bank_account_number: string
      bank_account_holder: string
      transfer_reference: string
      created_at: Date
    }[]
  >`
    SELECT id, event, refund_amount, reason, status, note,
           bank_name, bank_account_number, bank_account_holder,
           transfer_reference, created_at
      FROM refunds
     WHERE lower(replace(customer, '@', '')) = ${key}
       AND status <> 'cancelled'
     ORDER BY created_at, id
  `
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    amount: Number(r.refund_amount),
    reason: r.reason ?? "",
    status: r.status,
    note: r.note ?? "",
    bank: r.bank_name ?? "",
    accountMask: maskAccount(r.bank_account_number ?? ""),
    accountHolder: r.bank_account_holder ?? "",
    reference: r.transfer_reference ?? "",
    createdAt: r.created_at.toISOString().slice(0, 10),
  }))
}

/** Her own refund, in a state she is still allowed to move. */
async function openRefundOf(
  id: number,
  handle: string,
  tx: DBExecutor,
): Promise<{ id: number; status: string }> {
  const [row] = await tx<{ id: number; status: string }[]>`
    SELECT id, status FROM refunds
     WHERE id = ${id}
       AND lower(replace(customer, '@', '')) = ${normalizeId(handle)}
     FOR UPDATE
  `
  if (!row) throw new Error("Refund tidak ditemukan")
  // Said plainly, because both are things she can see on her own card and
  // neither is something she can undo by trying again.
  if (row.status === "refunded") throw new Error("Dana sudah dikirim")
  if (!OPEN_STATUSES.includes(row.status)) throw new Error("Pengembalian ini sudah ditutup")
  return row
}

/**
 * Keep it on her account for the next order.
 *
 * Deliberately does not name a target order: she may not have one yet, and
 * guessing which future order it lands on is the shop's decision when that
 * order exists. applyRefundAsCredit is what actually moves the money, and it
 * stays a staff action.
 */
export async function chooseRefundCredit(
  id: number,
  handle: string,
  db: DBExecutor = sql,
): Promise<void> {
  await openRefundOf(id, handle, db)
  await db`
    UPDATE refunds
       SET status = 'applied_to_next_order',
           bank_name = '', bank_account_number = '', bank_account_holder = '',
           updated_at = NOW()
     WHERE id = ${id}
  `
}

/**
 * Send it to her bank.
 *
 * The details land on the refund, never on `customers`: where one refund goes
 * is a decision about that refund, and a number copied to her profile would
 * still be there six months later when the account has closed.
 */
export async function chooseRefundBank(
  id: number,
  handle: string,
  input: { bank: string; accountNumber: string; accountHolder: string },
  db: DBExecutor = sql,
): Promise<void> {
  const bank = String(input.bank ?? "").trim()
  const holder = String(input.accountHolder ?? "").trim()
  const number = String(input.accountNumber ?? "").replace(/[\s-]/g, "")

  if (!bank) throw new Error("Pilih bank tujuan")
  if (!holder) throw new Error("Isi nama pemilik rekening")
  if (!/^[0-9]{6,20}$/.test(number)) throw new Error("Nomor rekening tidak valid")
  if (bank.length > 80 || holder.length > 120) throw new Error("Isian terlalu panjang")

  await openRefundOf(id, handle, db)
  await db`
    UPDATE refunds
       SET status = 'ready_to_refund',
           bank_name = ${bank},
           bank_account_number = ${number},
           bank_account_holder = ${holder},
           updated_at = NOW()
     WHERE id = ${id}
  `
}
