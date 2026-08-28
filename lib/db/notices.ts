import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { notifyCustomer } from "./announcements"
import { createRefund } from "./finance"
import { unknownTokens } from "../notice-templates"
import { REFUND_REASONS } from "./types"

/**
 * Telling one customer something about one trip.
 *
 * The notice and whatever it announces are one action. A refund notice that
 * does not create the refund promises money the system has no record of, and
 * the promise is then only as good as somebody remembering it.
 */

export interface NoticeRefund {
  /** One of REFUND_REASONS — stored on the row so her card says the same word later. */
  cause: string
  amount: number
  /** Which line it was about, when it was about a line at all. */
  orderId?: number | null
  affectedUnits?: number
  /** The items in words, for the refund's own note. */
  items?: string
  /**
   * Add to the customer's existing pending refund for this trip and cause
   * rather than opening another one.
   *
   * Marks arrive one product at a time, and five unavailable items used to
   * become five refunds: five payouts to make, five things to tick off, and
   * five rows racing to price themselves against the same invoice. One row per
   * customer per cause grows instead, and the notice each mark sends carries
   * the running total -- so the last message she reads is the whole story.
   */
  mergePending?: boolean
}

export interface NoticeInput {
  event: string
  customer: string
  title: string
  body: string
  refund?: NoticeRefund | null
}

export async function sendInvoiceNotice(
  input: NoticeInput,
  db: DBExecutor = sql,
): Promise<{ refundId: number | null }> {
  const title = String(input.title ?? "").trim()
  const body = String(input.body ?? "").trim()
  if (!input.event) throw new Error("event is required")
  if (!input.customer) throw new Error("customer is required")
  if (!title || !body) throw new Error("A title and a message are both required")

  // A placeholder she would read literally. Blanking it would hide the typo
  // and send her a sentence with a hole in it, so nothing goes at all.
  const bad = unknownTokens(`${title} ${body}`)
  if (bad.length) throw new Error(`${bad.join(", ")} is not a placeholder we know`)

  let refundId: number | null = null

  if (input.refund) {
    const { cause, amount } = input.refund
    if (!REFUND_REASONS.includes(cause)) throw new Error("Unknown refund reason")
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("A refund needs an amount")

    const items = input.refund.items ?? ""

    // Serialised on the customer and cause before anything is read, because
    // FOR UPDATE cannot lock a row that does not exist yet: five marks landing
    // together would each find no pending refund and each open one. The lock is
    // held to the end of this transaction, so the second mark waits and then
    // sees what the first wrote.
    if (input.refund.mergePending) {
      const scope = `${input.event}|${input.customer.trim().toLowerCase().replace(/@/g, "")}|${cause}`
      await db`SELECT pg_advisory_xact_lock(hashtext(${scope}))`
    }

    const [open] = input.refund.mergePending
      ? ((await db`
          SELECT id, refund_amount::int AS amount, affected_units, note
            FROM refunds
           WHERE event = ${input.event}
             AND lower(replace(customer, '@', '')) = lower(replace(${input.customer}, '@', ''))
             AND reason = ${cause}
             AND status = 'pending'
           ORDER BY id
           LIMIT 1
           FOR UPDATE
        `) as unknown as { id: number; amount: number; affected_units: number; note: string }[])
      : []

    if (open) {
      // The note grows into a list, and never repeats a line: marking the same
      // product twice is a correction, not a second item.
      const lines = String(open.note ?? "").split("\n").map((l) => l.trim()).filter(Boolean)
      for (const line of items.split("\n").map((l) => l.trim()).filter(Boolean)) {
        if (!lines.includes(line)) lines.push(line)
      }
      await db`
        UPDATE refunds
           SET refund_amount = refund_amount + ${Math.round(amount)},
               affected_units = COALESCE(affected_units, 0) + ${input.refund.affectedUnits ?? 0},
               note = ${lines.join("\n")},
               updated_at = NOW()
         WHERE id = ${open.id}
      `
      refundId = open.id
    } else {
      const created = await createRefund({
        event: input.event,
        customer: input.customer,
        reason: cause,
        refundAmount: Math.round(amount),
        orderId: input.refund.orderId ?? null,
        affectedUnits: input.refund.affectedUnits ?? 0,
        note: items,
      }, db)
      refundId = created.id
    }
  }

  await notifyCustomer(input.customer, { title, body }, db)
  return { refundId }
}
