import { parseCodes } from "@/lib/whatsapp/codes"
import { parseQuantity } from "@/lib/claims/quantity"
import { findCustomerByNumber } from "@/lib/whatsapp/identity"
import { normalizeNumber } from "@/lib/db/whatsapp-groups"
import {
  getOpenSendForGroup, getSendByMessage, getSendCodeByCode, listSendCodes, type WaSend, type WaSendCode,
} from "@/lib/db/wa-sends"
import { createDirectClaim, createRejectedClaim } from "@/lib/db/catalogue-requests"

export type ProductPostResolution =
  | { kind: "reacted"; emoji: string }
  | { kind: "needsDisambiguation"; send: WaSend; customerHandle: string; qty: number; note: string; candidates: WaSendCode[] }
  | { kind: "notApplicable" }

async function resolveSend(groupJid: string, quoted: string): Promise<WaSend | null> {
  if (quoted) return getSendByMessage(groupJid, quoted)
  return getOpenSendForGroup(groupJid)
}

async function resolveCustomerHandle(sender: string): Promise<string> {
  const number = normalizeNumber(sender)
  const handle = await findCustomerByNumber(number)
  return handle ?? number
}

/** Tokens in a product name at least 3 characters long — long enough that a
 *  match isn't noise, matching both the exact-token and fuzzy passes below. */
function nameTokens(productName: string): string[] {
  return productName.toLowerCase().split(/[\s-]+/).filter((t) => t.length >= 3)
}

/**
 * Resolve one incoming WhatsApp message against product-post sends.
 *
 * `"reacted"` means this function fully handled it — a direct claim (📝), an
 * unrecognised code (😢), or a closed trip (❌) — and already wrote whatever
 * row that implies. `"needsDisambiguation"` means the caller (Task 9's
 * askDisambiguation) must post the ❔ question before writing anything, since
 * this function has no live socket to post with. `"notApplicable"` means the
 * caller falls through to the existing shelf path.
 *
 * Text-driven only: unlike a shelf, a resent/unmarked photo of the post
 * creates nothing here.
 */
export async function resolveProductPostClaim(input: {
  groupJid: string; messageId: string; sender: string; text: string; quoted: string
}): Promise<ProductPostResolution> {
  const send = await resolveSend(input.groupJid, input.quoted)
  if (send === null) return { kind: "notApplicable" }

  const customerHandle = await resolveCustomerHandle(input.sender)
  const qty = parseQuantity(input.text)

  // Closed trip: the send resolved (by quote or by group binding) but its
  // event is not the group's currently-bound one.
  const openForGroup = await getOpenSendForGroup(input.groupJid)
  if (openForGroup === null || openForGroup.event !== send.event) {
    await createRejectedClaim({
      customerHandle, qty, note: input.text,
      sendId: send.id, sender: input.sender, messageId: input.messageId,
    })
    return { kind: "reacted", emoji: "❌" }
  }

  const codes = parseCodes(input.text)
  if (codes.length === 1) {
    const sendCode = await getSendCodeByCode(send.event, codes[0])
    if (sendCode === null) return { kind: "reacted", emoji: "😢" }
    await createDirectClaim({
      customerHandle, productId: sendCode.productId, qty, note: input.text,
      sendId: send.id, sendCodeId: sendCode.id, sender: input.sender, messageId: input.messageId,
    })
    return { kind: "reacted", emoji: "📝" }
  }

  const sendCodes = await listSendCodes(send.id)
  const lowerText = input.text.toLowerCase()

  // Exact, unique token match (e.g. a store code like "2099A1") — same
  // confidence as a typed code, so this is a direct claim, not a candidate.
  const exactMatches = sendCodes.filter((c) => nameTokens(c.productName).some((t) => lowerText.includes(t)))
  if (exactMatches.length === 1) {
    const match = exactMatches[0]
    await createDirectClaim({
      customerHandle, productId: match.productId, qty, note: input.text,
      sendId: send.id, sendCodeId: match.id, sender: input.sender, messageId: input.messageId,
    })
    return { kind: "reacted", emoji: "📝" }
  }
  if (exactMatches.length > 1) {
    return { kind: "needsDisambiguation", send, customerHandle, qty, note: input.text, candidates: exactMatches }
  }

  // No exact token either — a looser pass (partial word, e.g. a colour) for
  // the plausible-candidates ❔ case. Empty is a valid outcome: "kodenya
  // yang mana kak?" with nothing to offer.
  const fuzzyMatches = sendCodes.filter((c) =>
    nameTokens(c.productName).some((t) => lowerText.includes(t.slice(0, Math.max(3, t.length - 2)))),
  )
  return { kind: "needsDisambiguation", send, customerHandle, qty, note: input.text, candidates: fuzzyMatches }
}
