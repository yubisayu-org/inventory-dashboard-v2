import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { normalizeId } from "./helpers"
import { notifyCustomer } from "./announcements"
import { findDuplicatePayment, type DuplicatePayment } from "./payment-duplicates"

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

/**
 * QRIS as the customer is offered it — or nothing at all.
 *
 * Two ceilings travel to her browser and one does not. Per payment and per
 * order are hers to respect while she fills the form, so the sheet needs them
 * to grey the button before she wastes a scan. The yearly ceiling is the
 * shop's turnover, and how close the year has come to it is nobody's business
 * but the shop's — so when that ceiling is reached, QRIS is simply not
 * offered, with no figure attached.
 */
export interface QrisOffer {
  imageUrl: string
  merchantName: string
  /** 0 means no ceiling. Inclusive: 100000 allows exactly 100.000. */
  maxPerPayment: number
  maxPerOrder: number
}

/** What one payment row has to be to count as QRIS money coming in. */
const QRIS = "QRIS"

interface QrisConfigRow {
  qris_enabled: boolean
  qris_image_url: string
  qris_merchant_name: string
  qris_max_per_payment: string
  qris_max_per_order: string
  qris_max_per_year: string
}

async function qrisConfig(db: DBExecutor): Promise<QrisConfigRow | null> {
  const [row] = await db<QrisConfigRow[]>`
    SELECT qris_enabled, qris_image_url, qris_merchant_name,
           qris_max_per_payment, qris_max_per_order, qris_max_per_year
      FROM business_profile ORDER BY id LIMIT 1
  `
  if (!row || !row.qris_enabled || !row.qris_image_url) return null
  return row
}

/**
 * What the shop has taken through QRIS in the last twelve months.
 *
 * Rolling, not calendar: a payment thirteen months old drops out on its own
 * and gives the allowance back, so nothing has to reset in January.
 *
 * Verified only, and staff-entered rows count as much as customer claims —
 * a scan the shop typed in itself is the shop's QRIS turnover just the same,
 * and it is turnover that decides how the acquirer classifies the merchant.
 * Refunds are not subtracted: money going back out is a separate transfer,
 * not an undoing of the transaction that was counted.
 */
async function qrisTakenThisYear(db: DBExecutor): Promise<number> {
  const [row] = await db<{ total: string | null }[]>`
    SELECT SUM(amount) AS total
      FROM payments
     WHERE account = ${QRIS}
       AND kind = 'deposit'
       AND is_checked
       AND rejected_at IS NULL
       AND pay_date >= CURRENT_DATE - INTERVAL '12 months'
  `
  return Number(row?.total ?? 0)
}

/** What this order has already put through QRIS, whether or not anyone has
 *  checked it yet. A claim nobody has ticked still holds its space — without
 *  that, three scans in one minute all pass, because none of them had been
 *  ticked when the next was filed. A refusal frees the room again: nothing
 *  was taken. */
async function qrisOnOrder(event: string, customer: string, db: DBExecutor): Promise<number> {
  const [row] = await db<{ total: string | null }[]>`
    SELECT SUM(amount) AS total
      FROM payments
     WHERE event = ${event}
       AND lower(replace(customer, '@', '')) = ${normalizeId(customer)}
       AND account = ${QRIS}
       AND kind = 'deposit'
       AND rejected_at IS NULL
  `
  return Number(row?.total ?? 0)
}

/**
 * The QR to show her, or null when QRIS is not on offer.
 *
 * Null covers every reason at once — switched off, no image uploaded, the
 * year's ceiling spent — because the sheet does the same thing in all three
 * cases and she is owed no explanation of the shop's turnover.
 */
export async function getQrisOffer(db: DBExecutor = sql): Promise<QrisOffer | null> {
  const row = await qrisConfig(db)
  if (!row) return null

  const maxPerYear = Number(row.qris_max_per_year)
  if (maxPerYear > 0 && (await qrisTakenThisYear(db)) >= maxPerYear) return null

  return {
    imageUrl: row.qris_image_url,
    merchantName: row.qris_merchant_name,
    maxPerPayment: Number(row.qris_max_per_payment),
    maxPerOrder: Number(row.qris_max_per_order),
  }
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
 * Thrown when her claim looks like one already on file, and she has not yet
 * said to send it anyway.
 *
 * A distinct type rather than a message, because the sheet has to do something
 * different with it: keep what she typed, say what the shop already has, and
 * turn Submit into "Send it anyway". Every other failure here is a dead end
 * she has to correct.
 */
export class DuplicateClaimError extends Error {
  readonly duplicate: DuplicatePayment

  constructor(duplicate: DuplicatePayment) {
    super("Pembayaran serupa sudah tercatat")
    this.name = "DuplicateClaimError"
    this.duplicate = duplicate
  }
}

/** Rupiah as the shop writes them, for a message she has to act on. */
function rupiah(n: number): string {
  return `Rp ${n.toLocaleString("id-ID")}`
}

/**
 * Refuses a QRIS claim that would break any of the three ceilings.
 *
 * The per-payment ceiling keeps one scan small. The per-order ceiling closes
 * what the per-payment one leaves open — the amount field is hers to edit, so
 * without it a whole order goes through QRIS in several small scans and no
 * single claim ever breaks a rule. The yearly ceiling is the one that bounds
 * the shop's turnover, and its message says only that QRIS is unavailable:
 * the figures behind it are the shop's business.
 */
async function refuseIfOverQrisCeiling(
  event: string,
  customer: string,
  amount: number,
  db: DBExecutor,
): Promise<void> {
  const row = await qrisConfig(db)
  if (!row) throw new Error("QRIS sedang tidak tersedia. Silakan transfer bank.")

  const perPayment = Number(row.qris_max_per_payment)
  if (perPayment > 0 && amount > perPayment) {
    throw new Error(`QRIS hanya untuk pembayaran sampai ${rupiah(perPayment)}`)
  }

  const perOrder = Number(row.qris_max_per_order)
  if (perOrder > 0) {
    const used = await qrisOnOrder(event, customer, db)
    if (used + amount > perOrder) {
      throw new Error(
        used > 0
          ? `${rupiah(used)} dari pesanan ini sudah lewat QRIS. Sisanya silakan transfer bank.`
          : `QRIS untuk satu pesanan maksimal ${rupiah(perOrder)}`,
      )
    }
  }

  const perYear = Number(row.qris_max_per_year)
  if (perYear > 0 && (await qrisTakenThisYear(db)) + amount > perYear) {
    throw new Error("QRIS sedang tidak tersedia. Silakan transfer bank.")
  }
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
  input: {
    handle: string
    event: string
    amount: unknown
    bank: string
    sender: string
    /** Set once she has seen what the shop already has and sent it anyway. */
    confirmDuplicate?: boolean
  },
  db: DBExecutor = sql,
): Promise<{ id: number; amount: number }> {
  const amount = cleanAmount(input.amount)
  // "qris" typed in any case is the same destination, and it is stored the one
  // way the dashboard's account list already spells it.
  const raw = String(input.bank ?? "").trim()
  const bank = raw.toUpperCase() === QRIS ? QRIS : raw
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

  // Every QRIS ceiling is checked again here. The browser greys the button,
  // but the amount is the customer's own field on her own machine — what the
  // sheet decided is a courtesy, and this is the rule.
  if (bank === QRIS) await refuseIfOverQrisCeiling(input.event, order.customer, amount, db)

  // Submitting twice because the first one seemed not to go through is the
  // ordinary way a customer files the same transfer twice. She is told what
  // the shop already has and may send it anyway — most of the time she is
  // right, and it is the shop that has not looked yet.
  if (!input.confirmDuplicate) {
    const duplicate = await findDuplicatePayment({
      customer: order.customer,
      event: input.event,
      amount,
      payDate: new Date().toISOString().slice(0, 10),
    }, db)
    if (duplicate) throw new DuplicateClaimError(duplicate)
  }

  const [row] = await db<{ id: number }[]>`
    INSERT INTO payments (event, customer, amount, account, remarks, pay_date, kind, reported_by)
    VALUES (${input.event}, ${order.customer}, ${amount}, ${bank}, ${sender},
            CURRENT_DATE, 'deposit', 'customer')
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
