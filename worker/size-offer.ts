import sql from "@/lib/db-pool"
import { normalizeSize, sizesIn, alternativeSizes } from "@/lib/claims/size"
import { isBotAdmin } from "@/lib/db/whatsapp-groups"
import { swapClaimSize } from "@/lib/whatsapp/swap"
import { recordOffer, findOffer, answerOffer } from "@/lib/whatsapp/offers"
import { senderNumber } from "./handle-command"

/** Yes, in the emoji a customer actually reaches for. */
const YES = new Set(["👍", "👌", "✅", "🆗", "☑️", "✔️", "✔", "☑"])
const NO = new Set(["👎", "❌", "🙅", "✖️", "✖", "❎"])

/**
 * Strip what a phone adds to an emoji.
 *
 * Skin tones and the variation selector are chosen by her keyboard, not by her,
 * and comparing them would make a swap depend on which thumb she picked.
 */
function bare(emoji: string): string {
  return emoji.replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, "")
}

/** Whether a reaction on an offer is a yes, a no, or neither. */
export function classifyAnswer(emoji: string): boolean | null {
  const clean = bare(emoji)
  if (YES.has(clean) || YES.has(emoji)) return true
  if (NO.has(clean) || NO.has(emoji)) return false
  return null
}

/**
 * The owner naming a different size, in a reply to somebody's claim.
 *
 * Two outcomes, and which one happens turns entirely on whether she has already
 * consented. If her own note offered this size — "kalau 95 nggak ada 100 juga
 * boleh" — the swap is applied on the spot: she said it, an admin read it, and
 * making her tap a thumb to repeat herself is the hassle this avoids. Otherwise
 * it becomes an offer waiting on her reaction, because nobody has her consent
 * and the bot must not invent it.
 *
 * Returns the reaction to put on the owner's own message: ✅ applied, ❔ waiting
 * on her, 😢 could not tell which claim was meant. Null when this was not a size
 * offer at all, which is nearly every message.
 */
export async function trySizeOffer(input: {
  groupJid: string
  messageId: string
  sender: string
  text: string
  quoted: string
}): Promise<string | null> {
  if (!input.text || !input.quoted) return null

  const mentioned = sizesIn(input.text)
  if (mentioned.length === 0) return null
  if (!(await isBotAdmin(senderNumber(input.sender)))) return null

  const claims = await sql`
    SELECT id, note, size FROM wa_claims
    WHERE message_id = ${input.quoted} AND state <> 'rejected'
    ORDER BY id ASC
  `
  if (claims.length === 0) return null

  // One message can carry several claims — three ticks in one photo. "100 ya"
  // then means one of three things and there is no way to tell which, so it is
  // refused out loud rather than applied to the wrong item.
  if (claims.length > 1) return "😢"

  const claim = claims[0]
  const current = (claim.size as string | null) ?? normalizeSize(claim.note as string)

  // "95 kosong kak, aku ambil 100 ya" names two sizes, and the first one is the
  // one she cannot have — which is how anybody would write it. So the offer is
  // whichever size is NOT the one she is already filed under, rather than the
  // first or the last, both of which depend on word order the owner never
  // agreed to follow.
  const candidates = mentioned.filter((size) => size !== current)

  // Only her own size mentioned: the owner is confirming, not proposing.
  if (candidates.length === 0) return null
  // Two new sizes in one sentence — "ada 100 atau 110" — is a question, not an
  // instruction. Refused rather than picking one on her behalf.
  if (candidates.length > 1) return "😢"

  const size = candidates[0]
  if (claim.size === size) return "✅"

  if (alternativeSizes(claim.note as string).includes(size)) {
    await swapClaimSize(claim.id as number, size)
    return "✅"
  }

  await recordOffer({
    claimId: claim.id as number,
    size,
    groupJid: input.groupJid,
    messageId: input.messageId,
  })
  return "❔"
}

/**
 * Her answer to an offer, landing as a reaction on the owner's message.
 *
 * Returns the reaction for that same message — ✅ agreed, ❌ declined — or null
 * when the reaction was not an answer to an offer, which is the common case.
 */
export async function trySizeAnswer(input: {
  groupJid: string
  messageId: string
  reactorJid: string
  emoji: string
}): Promise<string | null> {
  const accepted = classifyAnswer(input.emoji)
  if (accepted === null) return null

  const offer = await findOffer(input.groupJid, input.messageId)
  if (offer === null) return null

  const answered = await answerOffer({
    offer,
    reactorNumber: senderNumber(input.reactorJid),
    accepted,
  })
  if (!answered) return null

  return accepted ? "✅" : "❌"
}
