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

    const created = await createRefund({
      event: input.event,
      customer: input.customer,
      reason: cause,
      refundAmount: Math.round(amount),
      orderId: input.refund.orderId ?? null,
      affectedUnits: input.refund.affectedUnits ?? 0,
      note: input.refund.items ?? "",
    }, db)
    refundId = created.id
  }

  await notifyCustomer(input.customer, { title, body }, db)
  return { refundId }
}
