import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { normalizeId } from "./helpers"
import { isLiveAmount } from "./live-refund"
import { applyRefundAsCredit } from "./finance"

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

/**
 * The states a customer may still move a refund out of — before she has
 * chosen, and no later.
 *
 * ready_to_refund and applied_to_next_order used to be here, so she could
 * switch or re-type her account. They are gone because the shop transfers by
 * hand and marks the row afterwards, sometimes much later: in that window the
 * money has already left for the account the row named, and an edit rewrites
 * the record of where it went. The row then disagrees with the bank statement
 * and there is nothing left to reconcile it against.
 *
 * A customer who mistyped asks the shop, which can still change it. That is
 * one message instead of a record that quietly stopped being true.
 */
const OPEN_STATUSES = ["pending", "awaiting_bank_info"]

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
  // Said apart from the closed case, because it is not the same news: this one
  // is still hers, it is just no longer hers to change on her own.
  if (row.status === "ready_to_refund" || row.status === "applied_to_next_order") {
    throw new Error("Pilihan sudah dicatat. Hubungi kami kalau perlu diubah.")
  }
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
 * Spend it on a trip she still owes for.
 *
 * The money is already hers and already counted — this only moves which
 * invoice carries it, off a settled trip where it does nothing and onto an
 * open one. Nothing leaves the shop's account, so nothing here waits for a
 * tick: the alternative is a customer watching an unchanged invoice while a
 * queue clears.
 *
 * applyRefundAsCredit does the writing, and re-checks everything decided here
 * inside its own transaction. What this adds is the customer's half of the
 * rules: the refund must be hers, in a state she may still direct, and the
 * target must be a trip of hers that is actually short.
 *
 * The amount is not hers to choose. It is whichever is smaller — what is left
 * of the credit, or what the trip is short — because any other figure either
 * spends money she does not have or overpays a trip into a second refund.
 */
export async function applyRefundToOrder(
  id: number,
  handle: string,
  targetEvent: string,
): Promise<{ applied: number; event: string }> {
  const key = normalizeId(handle)
  const target = String(targetEvent ?? "").trim()
  if (!target) throw new Error("Pilih pesanan dulu")

  const [refund] = await sql<{ id: number; event: string; amount: number; reason: string; status: string }[]>`
    SELECT id, event, refund_amount::int AS amount, reason, status
      FROM refunds
     WHERE id = ${id} AND lower(replace(customer, '@', '')) = ${key}
  `
  if (!refund) throw new Error("Pengembalian tidak ditemukan")
  // Sent already, or on its way to a bank: not money on her account any more.
  if (refund.status === "refunded" || refund.status === "ready_to_refund") {
    throw new Error("Dana ini sudah diproses ke rekening")
  }
  if (!OPEN_STATUSES.includes(refund.status) && refund.status !== "applied_to_next_order") {
    throw new Error("Pengembalian ini sudah ditutup")
  }
  if (target === refund.event) throw new Error("Pilih pesanan yang lain")

  // What is left of it. A refund whose figure is read from the balance rather
  // than stored — see isLiveAmount — is worth whatever she is overpaid by
  // today, which is the same rule applyRefundAsCredit applies.
  let remaining = refund.amount
  if (isLiveAmount(refund)) {
    const [live] = await sql<{ balance: number }[]>`
      SELECT balance FROM live_balances
       WHERE event = ${refund.event} AND customer = ${key}
    `
    remaining = Math.max(0, Number(live?.balance ?? 0))
  }
  if (!(remaining > 0)) throw new Error("Tidak ada sisa dana di akun Anda")

  // Her own trip, and short. balance is paid minus invoiced, so owing is
  // negative — the same view her Orders page reads.
  const [owing] = await sql<{ short: number }[]>`
    SELECT (-balance)::int AS short FROM live_balances
     WHERE event = ${target} AND customer = ${key} AND balance < 0
  `
  if (!owing) throw new Error("Pesanan itu tidak punya sisa tagihan")

  const applied = Math.min(remaining, owing.short)
  await applyRefundAsCredit(id, target, applied, `customer:${handle}`)
  return { applied, event: target }
}

/**
 * What she still owes across every trip, or 0.
 *
 * customer_invoice_summary is the same view the balance strip on her Orders
 * page reads, so the server and the page cannot disagree about whether she
 * owes — which is the whole point of not recomputing it here.
 */
async function outstandingFor(handle: string, db: DBExecutor): Promise<number> {
  const [row] = await db<{ total_outstanding: string }[]>`
    SELECT total_outstanding FROM customer_invoice_summary
     WHERE cust_key = ${normalizeId(handle)}
  `
  return Number(row?.total_outstanding ?? 0)
}

/**
 * Send it to her bank.
 *
 * The details land on the refund, never on `customers`: where one refund goes
 * is a decision about that refund, and a number copied to her profile would
 * still be there six months later when the account has closed.
 *
 * Refused while she owes. The page already greys the button, but a page is not
 * a rule: a tab that rendered before her latest invoice still has a live one,
 * and anything posting here that is not the page never saw it at all. Sending
 * money back to an account still in the red is two transfers to close one gap,
 * and both cost a fee.
 *
 * Only this way out is closed. chooseRefundCredit stays open because credit is
 * the option that works when she owes: it closes the same gap with nothing
 * moving. And this is the CUSTOMER path only — the shop refunds through its own
 * screens, so the shop can still send money to someone who owes when it means
 * to.
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

  if ((await outstandingFor(handle, db)) > 0) {
    throw new Error(
      "Masih ada pesanan yang belum lunas, jadi pengembalian ini dipotong dari situ dulu.",
    )
  }
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
