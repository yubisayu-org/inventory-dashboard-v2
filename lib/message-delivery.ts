/**
 * How each kind of message reaches the customer.
 *
 * Every message screen used to offer both a Copy button and a WhatsApp button.
 * Which one gets pressed is not a decision about this message -- it is how the
 * shop talks to people, and it differs by kind rather than by moment: an
 * invoice goes to the DM she ordered in, a refund goes to WhatsApp where her
 * bank details are. Two buttons made that standing choice again every time.
 *
 * Client-safe on purpose: the settings screen, every message screen and the
 * button itself all read these, and none of them may pull the database driver
 * into the browser bundle.
 */
export type DeliveryMode = "copy" | "whatsapp"

/** Which message this is. The List Order row button sends the invoice message,
 *  so it follows `invoice` rather than being a kind of its own. */
export type MessageKind = "invoice" | "refund" | "shipment"

export const MESSAGE_KINDS: MessageKind[] = ["invoice", "refund", "shipment"]

export const MESSAGE_KIND_LABELS: Record<MessageKind, string> = {
  invoice: "Invoice",
  refund: "Refund",
  shipment: "Shipment",
}

export const MESSAGE_KIND_HINTS: Record<MessageKind, string> = {
  invoice: "The bill, from the Invoice page and the Order list.",
  refund: "Money going back, from the refund sheet.",
  shipment: "The confirmation that a parcel has gone.",
}

export const DELIVERY_LABELS: Record<DeliveryMode, string> = {
  copy: "Copy",
  whatsapp: "Send on WhatsApp",
}

export type MessageDelivery = Record<MessageKind, DeliveryMode>

/** What every screen did before this setting existed. */
export const DEFAULT_MESSAGE_DELIVERY: MessageDelivery = {
  invoice: "copy",
  refund: "copy",
  shipment: "copy",
}

/**
 * Read a stored value into something every caller can rely on.
 *
 * The column is JSONB, so it can hold anything a bad write put there. A key we
 * do not know is dropped and a value we do not know becomes "copy" -- copying
 * is the harmless one: it puts the text on the clipboard and waits, where an
 * unexpected "whatsapp" opens a chat window with a message in it.
 */
export function normalizeDelivery(raw: unknown): MessageDelivery {
  const out = { ...DEFAULT_MESSAGE_DELIVERY }
  // A jsonb column can hold a JSON *string* as easily as an object -- writing
  // `${JSON.stringify(x)}::jsonb` produces exactly that, and it reads back as
  // the text of the settings rather than the settings. Unwrapped here so a row
  // written that way still answers correctly instead of silently defaulting.
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw) } catch { return out }
  }
  if (!raw || typeof raw !== "object") return out
  for (const kind of MESSAGE_KINDS) {
    const v = (raw as Record<string, unknown>)[kind]
    if (v === "whatsapp" || v === "copy") out[kind] = v
  }
  return out
}

/**
 * A WhatsApp deep link with the message already in it.
 *
 * Indonesian numbers are stored however they were typed: 08…, 8…, +62…, with
 * spaces and dashes. WhatsApp wants digits in international form. Without a
 * number at all we open its own chat picker rather than refusing -- you still
 * end up in WhatsApp, just choosing the chat yourself.
 *
 * This existed three times: twice correctly, and once as `wa.me/?text=` with no
 * number at all, so the refund screen always made you find her by hand even
 * when her number was on file.
 */
export function waLink(whatsapp: string | null | undefined, message: string): string {
  const text = encodeURIComponent(message)
  let num = (whatsapp ?? "").replace(/\D/g, "")
  if (num.startsWith("0")) num = "62" + num.slice(1)
  else if (num.startsWith("8")) num = "62" + num
  return num ? `https://wa.me/${num}?text=${text}` : `https://api.whatsapp.com/send?text=${text}`
}
