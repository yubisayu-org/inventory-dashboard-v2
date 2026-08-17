import sql from "@/lib/db-pool"
import { normalizeNumber } from "@/lib/db/whatsapp-groups"
import { swapClaimSize } from "./swap"

export interface SizeOffer {
  id: number
  claimId: number
  size: string
  /** The number that claimed, so only she can answer for it. */
  sender: string
  answered: boolean
}

/**
 * Remember that a size was offered, so a 👍 later means something.
 *
 * Keyed on the owner's message rather than the customer's claim: her reaction
 * lands on what he said, and that is the only thread tying the answer back to
 * the claim it is about.
 *
 * A second offer on the same message is ignored rather than replacing the first
 * — messages arrive twice on a flaky connection, and the second copy carries no
 * new intent.
 */
export async function recordOffer(input: {
  claimId: number
  size: string
  groupJid: string
  messageId: string
}): Promise<void> {
  await sql`
    INSERT INTO wa_size_offers (claim_id, size, group_jid, message_id)
    VALUES (${input.claimId}, ${input.size}, ${input.groupJid}, ${input.messageId})
    ON CONFLICT (group_jid, message_id) DO NOTHING
  `
}

/** The offer a reaction is answering, if it is answering one. */
export async function findOffer(groupJid: string, messageId: string): Promise<SizeOffer | null> {
  const [row] = await sql`
    SELECT o.id, o.claim_id, o.size, o.answered_at, c.sender
    FROM wa_size_offers o JOIN wa_claims c ON c.id = o.claim_id
    WHERE o.group_jid = ${groupJid} AND o.message_id = ${messageId}
  `
  if (!row) return null
  return {
    id: row.id as number,
    claimId: row.claim_id as number,
    size: row.size as string,
    sender: (row.sender as string) ?? "",
    answered: row.answered_at !== null,
  }
}

/**
 * Take the customer's answer to an offer.
 *
 * Only from the number that made the claim. A group is full of people, and
 * anybody's thumb on the owner's message would otherwise change somebody else's
 * order — the one mistake in this whole flow that a customer could not detect
 * until delivery.
 *
 * Accepting swaps the size; declining changes nothing at all, leaving her on the
 * size she asked for and short. That is the honest state: she turned down this
 * shelf's alternative, not the item, and the next store may have her size.
 *
 * Returns false when the answer was not hers to give or was already given, so
 * the caller knows not to react.
 */
export async function answerOffer(input: {
  offer: SizeOffer
  reactorNumber: string
  accepted: boolean
}): Promise<boolean> {
  if (input.offer.answered) return false
  if (normalizeNumber(input.offer.sender) !== normalizeNumber(input.reactorNumber)) return false

  if (input.accepted) await swapClaimSize(input.offer.claimId, input.offer.size)

  await sql`
    UPDATE wa_size_offers SET answered_at = NOW(), accepted = ${input.accepted}
    WHERE id = ${input.offer.id}
  `
  return true
}
