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
  | "inbox_order_cancelled"
  | "inbox_ongkir_extra"
  | "inbox_ongkir_credit"
  | "inbox_ongkir_reweighed"
  | "inbox_ongkir_reweighed_less"
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
    key: "inbox_ongkir_extra",
    label: "Extra shipping fee",
    title: "Ongkir tambahan {amount} · {event}",
    body:
      "Sebagian pesanan Anda sudah tiba dan akan kami kirim lebih dulu. Karena menjadi dua paket, "
      + "ada tambahan ongkir {amount} yang perlu diselesaikan sebelum paket berangkat.",
  },
  {
    key: "inbox_ongkir_credit",
    label: "Shipping discount",
    title: "Diskon ongkir {amount} · {event}",
    body:
      "Pesanan Anda kami gabung menjadi satu paket, sehingga ongkir berkurang {amount}. "
      + "Tagihan Anda sudah kami sesuaikan.",
  },
  {
    key: "inbox_ongkir_reweighed",
    label: "Courier weighed it heavier",
    title: "Ongkir tambahan {amount} · {event}",
    // Apologetic on purpose: she is being charged after her parcel left, for
    // something she did not cause and could not have known.
    body:
      "Paket Anda ditimbang {chargedKg} kg oleh kurir, sedangkan estimasi kami {estimatedKg} kg. "
      + "Selisihnya menambah ongkir {amount} pada tagihan {event}.\n\n"
      + "Mohon maaf atas ketidaknyamanannya — berat sebenarnya baru diketahui setelah paket ditimbang.",
  },
  {
    key: "inbox_ongkir_reweighed_less",
    label: "Courier weighed it lighter",
    // The same correction the other way. Sending the heavier wording for money
    // going back to her announces a charge that is really a refund, and
    // apologises for it.
    title: "Ongkir berkurang {amount} · {event}",
    body:
      "Paket Anda ditimbang {chargedKg} kg oleh kurir, lebih ringan dari estimasi kami "
      + "{estimatedKg} kg. Selisihnya {amount} sudah kami kurangkan dari tagihan {event}.",
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
    // She asked for it to come off. Sent whether or not any money moves: an
    // unpaid order simply costs less, and she should hear that from the shop
    // rather than notice it on an invoice later.
    key: "inbox_order_cancelled",
    label: "Order cancelled at her request",
    title: "Cancelled from {event}",
    body:
      "As you asked, we have taken these off your order for {event}:\n{itemsList}\n\n"
      + "Your bill for this trip goes down by {amount}.",
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
  /** Names what turned up instead, so it needs {receivedItem} to say it. */
  needsReceived?: boolean
  /**
   * A mark on the Shopping or Arrival List already produces this reason, with
   * the item, the units and the notice, in one action. Offering it again in a
   * hand-written refund invites a second refund for the same thing — and one
   * that leaves the order still claiming units nobody will receive.
   */
  fromMark?: boolean
  /**
   * Kept so refunds already carrying it still read properly, and not offered
   * for new ones. A reason nobody can choose is one nobody has to interpret
   * later.
   */
  retired?: boolean
  /** Wording for when nobody recorded what turned up. */
  lineWithout?: string
  /**
   * The same sentence for WhatsApp, in Indonesian.
   *
   * Not a translation of `line`: the inbox card sits beside buttons that ask
   * how she wants the money, and the WhatsApp message has to ask for bank
   * details in writing. What stays identical is which reason is being given —
   * the two must never tell one customer two different stories.
   */
  waLine?: string
  waLineWithout?: string
}

/**
 * The sentence to send: the one that names the substitute only when there is a
 * substitute to name. A template quietly missing a value would reach her with
 * "{receivedItem}" printed in it, or — worse — refuse to send at all, and a
 * notice that fails to send is the one outcome this file exists to prevent.
 */
export function causeLineFor(
  cause: RefundCause,
  have: { items?: string; receivedItem?: string } = {},
  channel: "inbox" | "whatsapp" = "inbox",
): string {
  const missing = (cause.needsReceived && !have.receivedItem?.trim())
    || (cause.needsItems && !have.items?.trim())
  if (channel === "whatsapp") {
    const full = cause.waLine ?? cause.line
    return missing ? (cause.waLineWithout ?? full) : full
  }
  return missing ? (cause.lineWithout ?? cause.line) : cause.line
}

export const REFUND_CAUSES: RefundCause[] = [
  {
    key: "unavailable",
    fromMark: true,
    label: "We could not buy it",
    needsItems: true,
    line: "We could not buy {itemsList} from {event}.",
    waLine: "Barang berikut tidak tersedia:\n{itemsList}",
    waLineWithout: "Ada barang yang tidak tersedia.",
  },
  {
    key: "damaged",
    fromMark: true,
    label: "It arrived damaged",
    needsItems: true,
    line: "{itemsList} arrived damaged, so we are not sending it.",
    waLine: "Barang berikut tiba dalam kondisi rusak sehingga tidak kami kirimkan:\n{itemsList}",
    waLineWithout: "Ada barang yang tiba dalam kondisi rusak sehingga tidak kami kirimkan.",
  },
  {
    key: "wrong_item",
    fromMark: true,
    label: "The wrong thing arrived",
    needsItems: true,
    needsReceived: true,
    // Naming the substitute used to be withheld on the grounds that it invited
    // a question she could not answer. She can answer it now, because we ask
    // it: the refund stands unless she says she would rather have what came.
    // Somebody has the thing in their hands either way, so she may as well be
    // the one to decide where it goes.
    line: "{itemsList} was not what arrived — {receivedItem} came instead, so we are not sending it. "
      + "If you would rather keep what came, message us and we will sort it out.",
    // What arrives when nobody recorded the substitute: a refund raised by hand
    // knows the reason but not the item, and a sentence with a hole in it is
    // worse than a shorter sentence.
    lineWithout: "{itemsList} was not what arrived, so we are not sending it.",
    waLine: "Barang yang datang tidak sesuai dengan pesanan Anda — yang kami terima adalah *{receivedItem}*, "
      + "sehingga pesanan berikut tidak kami kirimkan:\n{itemsList}\n\n"
      + "Jika Anda ingin tetap mengambil barang yang datang, silakan beri tahu kami.",
    waLineWithout: "Barang yang datang tidak sesuai dengan pesanan berikut sehingga tidak kami kirimkan:\n{itemsList}",
  },
  {
    key: "overpayment",
    label: "They paid more than the total",
    fixed: true,
    // Says what happened, not why: this cause covers both a discount applied
    // after she paid and a transfer typed wrong, and the shop's own row is
    // usually generated from paid > invoiced, which cannot tell them apart.
    line: "You paid more than your order for {event} came to.",
    waLine: "Pembayaran Anda melebihi total pesanan.",
  },
  {
    key: "shipping_loss",
    fromMark: true,
    label: "The parcel was lost",
    needsItems: true,
    // Which of her things went astray, not just that something did: a trip can
    // carry several parcels for one customer, and "your parcel from {event}"
    // leaves her counting what is still coming.
    line: "{itemsList} was lost on its way to you from {event}.",
    lineWithout: "Your parcel from {event} was lost on its way to you.",
    waLine: "Barang berikut hilang dalam pengiriman:\n{itemsList}",
    waLineWithout: "Paket Anda hilang dalam pengiriman.",
  },
  {
    key: "quality",
    label: "Not as good as promised",
    needsItems: true,
    // Deliberately not "damaged". That one means the parcel arrived broken and
    // was caught before it went out; this is the shop's own check having missed
    // something, found by the customer after she opened the box. Counting them
    // separately is the only way to learn anything from either.
    line: "{itemsList} tidak sesuai dengan kualitas yang kami janjikan. "
      + "Maaf — ini luput dari pemeriksaan kami sebelum dikirim.",
    waLine: "Barang berikut tidak sesuai dengan kualitas yang kami janjikan:\n{itemsList}\n\n"
      + "Mohon maaf, ini luput dari pemeriksaan kami sebelum dikirim.",
    waLineWithout: "Ada barang yang tidak sesuai dengan kualitas yang kami janjikan. "
      + "Mohon maaf, ini luput dari pemeriksaan kami.",
  },
  {
    key: "goodwill",
    label: "Goodwill",
    line: "A goodwill refund from us on {event}.",
    waLine: "Sebagai bentuk permohonan maaf kami atas ketidaknyamanan yang terjadi.",
  },
  // Retired. Everything it was reached for turned out to have a name: money
  // she paid that she should not have is an overpayment however it arose, and
  // a gesture is goodwill. A catch-all with no sentence of its own left the
  // customer a refund that explained nothing, and left the shop guessing six
  // weeks later at what it had been for.
  //
  // Still here because old refunds carry it and have to keep reading properly.
  { key: "other", label: "Something else", retired: true, line: "", waLine: "Terdapat penyesuaian pada pesanan Anda." },
]

/** The reasons nobody can mark — what is left for a person to decide. */
export const MANUAL_REFUND_CAUSES = REFUND_CAUSES.filter((c) => !c.fromMark && !c.retired)

/** Everything still offered anywhere, marks included. */
export const OFFERED_REFUND_CAUSES = REFUND_CAUSES.filter((c) => !c.retired)

export const NOTICE_TOKENS = [
  "{customer}",
  "{event}",
  "{total}",
  "{outstanding}",
  "{refundAmount}",
  "{itemsList}",
  "{receivedItem}",
  "{amount}",
  "{chargedKg}",
  "{estimatedKg}",
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
  inbox_refund_offered: ["{customer}", "{event}", "{refundAmount}", "{cause}", "{itemsList}", "{receivedItem}"],
  inbox_payment_confirmed: ["{customer}", "{event}", "{total}"],
  inbox_waiting_payment: ["{customer}", "{event}", "{total}", "{outstanding}"],
  inbox_delayed: ["{customer}", "{event}"],
  inbox_order_cancelled: ["{customer}", "{event}", "{itemsList}", "{amount}"],
  inbox_ongkir_extra: ["{customer}", "{event}", "{amount}"],
  inbox_ongkir_credit: ["{customer}", "{event}", "{amount}"],
  inbox_ongkir_reweighed: ["{customer}", "{event}", "{amount}", "{chargedKg}", "{estimatedKg}"],
  inbox_ongkir_reweighed_less: ["{customer}", "{event}", "{amount}", "{chargedKg}", "{estimatedKg}"],
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
