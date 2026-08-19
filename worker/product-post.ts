import { parseCodes } from "@/lib/whatsapp/codes"
import { parseQuantity } from "@/lib/claims/quantity"
import { findCustomerByNumber } from "@/lib/whatsapp/identity"
import { senderNumber } from "./handle-command"
import {
  getOpenSendForGroup, getSendByMessage, getSendCodeByCode, listOpenSendsForEvent, listSendCodes,
  type WaSend, type WaSendCode,
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
  // senderNumber, not normalizeNumber: a real group participant JID is
  // routinely device-suffixed (628123456789:12@s.whatsapp.net), and
  // normalizeNumber's plain digit-strip merges that suffix into the number
  // instead of dropping it, matching no real customer. senderNumber strips
  // it first, same as every other identity lookup in this worker
  // (worker/handle-command.ts).
  const number = senderNumber(sender)
  const handle = await findCustomerByNumber(number)
  return handle ?? number
}

/** Tokens in a product name at least 3 characters long — long enough that a
 *  match isn't noise, matching both the exact-token and fuzzy passes below. */
function nameTokens(productName: string): string[] {
  return productName.toLowerCase().split(/[\s-]+/).filter((t) => t.length >= 3)
}

/** The whole words in a message, lowercased — used for word-boundary
 *  matching instead of "does this string appear anywhere", which false-
 *  positives on a short generic token buried inside an unrelated word (a
 *  product's "bag" token substring-matching "yang bagus", for instance). */
function wordsIn(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))
}

/** A product name token appears as a whole, standalone word in the message —
 *  confident enough to write a direct claim from, same as a typed code. */
function exactTokenMatch(sendCode: WaSendCode, words: Set<string>): boolean {
  return nameTokens(sendCode.productName).some((t) => words.has(t))
}

/**
 * A looser, typo-tolerant pass for the plausible-candidates ❔ case: some
 * word in the message starts with a truncated prefix of the token (e.g.
 * "greij…" against the token "greige"). Deliberately word-anchored, not
 * "appears anywhere in the text", for the same reason exactTokenMatch is.
 *
 * Tokens short enough that truncation is a no-op (3 letters, e.g. "bag")
 * are skipped here entirely — exactTokenMatch already covers them at full
 * confidence, and testing them again here would only reintroduce exactly
 * the generic-substring false positive ("bagus" starting with "bag") that
 * moving to word-boundary matching exists to fix.
 */
function fuzzyTokenMatch(sendCode: WaSendCode, words: Set<string>): boolean {
  return nameTokens(sendCode.productName).some((t) => {
    const prefix = t.slice(0, Math.max(3, t.length - 2))
    if (prefix.length >= t.length) return false
    for (const w of words) if (w.startsWith(prefix)) return true
    return false
  })
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

  // Two or more store codes named in one message ("K41 sama K42 masing-
  // masing 1") — resolve each to its own wa_send_codes row and offer them
  // as candidates, rather than falling through to name matching (which
  // usually finds nothing when the message already named exact codes).
  // Codes are looked up globally by (event, code), so this is unaffected by
  // which send they individually belong to.
  if (codes.length > 1) {
    const resolved = await Promise.all(codes.map((c) => getSendCodeByCode(send.event, c)))
    const candidates = resolved.filter((c): c is WaSendCode => c !== null)
    if (candidates.length > 0) {
      return { kind: "needsDisambiguation", send, customerHandle, qty, note: input.text, candidates }
    }
    // None of the named codes actually resolved — fall through exactly as
    // if no code-shaped token had been found at all.
  }

  if (codes.length === 1) {
    const sendCode = await getSendCodeByCode(send.event, codes[0])
    if (sendCode === null) return { kind: "reacted", emoji: "😢" }
    // sendCode.sendId, not send.id: a code is looked up globally within the
    // event, so the code she typed can belong to an OLDER send of the same
    // trip than whichever one resolveSend picked (the newest, or the one
    // she quoted). Recording the wrong send here would disagree with
    // send_code_id's own send in a future inbox UI.
    await createDirectClaim({
      customerHandle, productId: sendCode.productId, qty, note: input.text,
      sendId: sendCode.sendId, sendCodeId: sendCode.id, sender: input.sender, messageId: input.messageId,
    })
    return { kind: "reacted", emoji: "📝" }
  }

  // Token/fuzzy matching is scoped to every currently-posted send for the
  // group's bound event (a trip can have more than one live post), not just
  // the newest one — otherwise a store-code-free claim against an earlier
  // post falls to disambiguation instead of a direct claim.
  const openSends = await listOpenSendsForEvent(send.event)
  const sendCodes = (await Promise.all(openSends.map((s) => listSendCodes(s.id)))).flat()
  const words = wordsIn(input.text)

  // Exact, whole-word token match (e.g. a store code like "2099A1", or a
  // distinctive full word from the name) — same confidence as a typed code,
  // so this is a direct claim, not a candidate.
  const exactMatches = sendCodes.filter((c) => exactTokenMatch(c, words))
  if (exactMatches.length === 1) {
    const match = exactMatches[0]
    // match.sendId, not send.id — same reasoning as the code-match path
    // above: the matched product can belong to a different send of this
    // event than whichever one resolveSend initially picked.
    await createDirectClaim({
      customerHandle, productId: match.productId, qty, note: input.text,
      sendId: match.sendId, sendCodeId: match.id, sender: input.sender, messageId: input.messageId,
    })
    return { kind: "reacted", emoji: "📝" }
  }
  if (exactMatches.length > 1) {
    return { kind: "needsDisambiguation", send, customerHandle, qty, note: input.text, candidates: exactMatches }
  }

  // No exact token either — a looser pass (partial word, e.g. a colour) for
  // the plausible-candidates ❔ case. Empty is a valid outcome: "kodenya
  // yang mana kak?" with nothing to offer — but ONLY when the message
  // actually engaged with this send in the first place (she quoted its own
  // post). Without an engagement signal — no code, no quote, zero
  // candidates — this is ordinary chatter ("halo kak", "makasih ya") that
  // merely happened to arrive while a send was open in the group, and must
  // fall through untouched exactly as it did before product posts existed.
  const fuzzyMatches = sendCodes.filter((c) => fuzzyTokenMatch(c, words))
  if (input.quoted === "" && fuzzyMatches.length === 0) {
    return { kind: "notApplicable" }
  }
  return { kind: "needsDisambiguation", send, customerHandle, qty, note: input.text, candidates: fuzzyMatches }
}
