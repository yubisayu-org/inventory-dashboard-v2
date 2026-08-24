// The wording of a notice the shop sends to one customer's inbox.
//
// Sibling of lib/message-templates.ts, which holds the WhatsApp messages the
// shop copies by hand. Same idea — house wording with {token} placeholders —
// aimed at the catalogue inbox instead, and carrying a title because an inbox
// item has one and a WhatsApp message does not.
//
// The wording lives here rather than in the database because a notice that
// fails to send is worse than a notice worded differently to house style: a
// blank or mangled template must never be the reason someone is not told about
// money. Per-message edits happen in the composer and touch nothing here.

export type NoticeKey =
  | "inbox_invoice_due"
  | "inbox_refund_offered"
  | "inbox_payment_confirmed"
  | "inbox_waiting_payment"
  | "inbox_delayed"
  | "inbox_custom"

export interface NoticeTemplate {
  key: NoticeKey
  label: string
  title: string
  body: string
  /** Only this one creates a refund row, and only it asks for a cause. */
  isRefund?: boolean
}

export const NOTICE_TEMPLATES: NoticeTemplate[] = [
  {
    key: "inbox_invoice_due",
    label: "Invoice ready to settle",
    title: "{event} · {outstanding} due",
    body:
      "Your order is complete and ready to settle. Open it in Order history to see the "
      + "items, then tell us once you have transferred — we check it against the bank "
      + "ourselves, so there is nothing to send us.",
  },
  {
    key: "inbox_refund_offered",
    label: "Refund coming",
    isRefund: true,
    title: "{refundAmount} is coming back to you",
    // The first sentence is written by the cause; everything after it is the
    // same whichever cause it was, because what she does next does not change.
    body:
      "{cause} That is {refundAmount} owed back to you.\n\n"
      + "Open the order to say whether to keep it on your account for next time, or have "
      + "us transfer it to your bank.",
  },
  {
    key: "inbox_payment_confirmed",
    label: "Payment confirmed",
    title: "Payment confirmed",
    body: "We found your transfer for {event} in the bank statement. Thank you.",
  },
  {
    key: "inbox_waiting_payment",
    label: "Still waiting on payment",
    title: "{event} is still waiting",
    body:
      "Your order is packed and ready, but {outstanding} is still outstanding. It goes "
      + "out the day the payment clears.",
  },
  {
    key: "inbox_delayed",
    label: "Trip delayed",
    title: "{event} is running late",
    body:
      "The trip has been pushed back, so your order will arrive later than the estimate "
      + "on your card. Nothing is lost — we will post the new date here as soon as it is "
      + "fixed.",
  },
  {
    key: "inbox_custom",
    label: "Something else",
    title: "About {event}",
    body: "",
  },
]

/**
 * Why money is coming back — the vocabulary `refunds.reason` already carries.
 *
 * The cause decides three things at once: the sentence she reads, the value
 * stored on the refund row, and what the composer asks for next. Two of them
 * are about particular lines, so only those two ask which.
 */
export interface RefundCause {
  key: string
  label: string
  line: string
  /** Ask which lines, and derive the amount from them. */
  needsItems?: boolean
  /** The invoice already knows the figure; do not ask for one. */
  fixed?: boolean
}

export const REFUND_CAUSES: RefundCause[] = [
  {
    key: "unavailable",
    label: "We could not buy it",
    needsItems: true,
    line: "We could not buy {itemsList} from {event}.",
  },
  {
    key: "damaged",
    label: "It arrived damaged",
    needsItems: true,
    line: "{itemsList} arrived damaged, so we are not sending it.",
  },
  {
    key: "overpayment",
    label: "She paid more than the total",
    fixed: true,
    line: "Your invoice for {event} came down after you had already paid.",
  },
  {
    key: "shipping_loss",
    label: "The parcel was lost",
    line: "Your parcel from {event} was lost on its way to you.",
  },
  {
    key: "goodwill",
    label: "Goodwill",
    line: "A goodwill refund from us on {event}.",
  },
  { key: "other", label: "Something else", line: "" },
]

export const NOTICE_TOKENS = [
  "{customer}",
  "{event}",
  "{total}",
  "{outstanding}",
  "{refundAmount}",
  "{itemsList}",
  "{cause}",
] as const

export type NoticeTokens = Partial<Record<(typeof NOTICE_TOKENS)[number], string>>

/**
 * Resolve placeholders against this trip's own figures.
 *
 * An unknown token is left exactly as written rather than silently blanked —
 * it is a mistake, and the caller refuses to send a message containing one.
 * Blanking it would hide the mistake and send her a sentence with a hole in it.
 */
export function fillNotice(text: string, values: NoticeTokens): string {
  return String(text ?? "").replace(/\{[a-zA-Z]+\}/g, (token) => {
    const known = (NOTICE_TOKENS as readonly string[]).includes(token)
    if (!known) return token
    return values[token as keyof NoticeTokens] ?? ""
  })
}

/** Placeholders that are not ours. Empty means the text is safe to send. */
export function unknownTokens(text: string): string[] {
  const found = String(text ?? "").match(/\{[a-zA-Z]+\}/g) ?? []
  return [...new Set(found.filter((t) => !(NOTICE_TOKENS as readonly string[]).includes(t)))]
}

export const NOTICE_KEYS: NoticeKey[] = NOTICE_TEMPLATES.map((t) => t.key)

/**
 * Which placeholders actually resolve for a given notice.
 *
 * Every token in NOTICE_TOKENS is *accepted* anywhere — fillNotice does not
 * care which template it is filling. This map is guidance for the settings
 * screen: {refundAmount} in "Trip delayed" is not an error, it just fills
 * with nothing, and the owner should be told that before they save it and
 * not after a customer reads the gap.
 */
export const NOTICE_TOKENS_FOR: Record<NoticeKey, string[]> = {
  inbox_invoice_due: ["{customer}", "{event}", "{total}", "{outstanding}"],
  inbox_refund_offered: ["{customer}", "{event}", "{refundAmount}", "{cause}", "{itemsList}"],
  inbox_payment_confirmed: ["{customer}", "{event}", "{total}"],
  inbox_waiting_payment: ["{customer}", "{event}", "{total}", "{outstanding}"],
  inbox_delayed: ["{customer}", "{event}"],
  inbox_custom: [...NOTICE_TOKENS],
}

/** An owner's edit to one notice. Either field may be blank, meaning "keep ours". */
export interface NoticeOverride {
  title?: string
  body?: string
}

/**
 * House wording with the owner's edits laid over it.
 *
 * Blank means "keep ours", per field rather than per template — an owner who
 * rewrote the body and left the title alone gets their body and our title,
 * and an override row for a key we no longer ship is ignored rather than
 * resurrected. inbox_custom is the one template whose default body is empty
 * on purpose, so a blank body there is indistinguishable from the default and
 * that is exactly right.
 */
export function applyNoticeOverrides(
  overrides: Partial<Record<NoticeKey, NoticeOverride>> | null | undefined,
): NoticeTemplate[] {
  if (!overrides) return NOTICE_TEMPLATES
  return NOTICE_TEMPLATES.map((t) => {
    const edit = overrides[t.key]
    if (!edit) return t
    return {
      ...t,
      title: edit.title?.trim() ? edit.title : t.title,
      body: edit.body?.trim() ? edit.body : t.body,
    }
  })
}
