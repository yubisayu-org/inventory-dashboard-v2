import sql from "@/lib/db-pool"
import { markClaimObtained } from "@/lib/db/claims"
import { isBotAdmin } from "@/lib/db/whatsapp-groups"
import { OUTCOME_REACTIONS } from "./reactions"
import { senderNumber } from "./handle-command"

/** Ticks and crosses the owner might reach for, including the variant selectors. */
const BOUGHT = new Set(["✅", "☑️", "✔️", "✔", "☑"])
const MISSED = new Set(["❌", "✖️", "✖", "❎"])

/**
 * What the owner meant by reacting to a claim.
 *
 * Only ticks and crosses. The bot's own capture vocabulary — 📝 ❔ 😢 — is
 * deliberately excluded: those are what the bot puts ON a claim, and reading
 * them back as an instruction would have it answering itself.
 */
export function classifyOwnerReaction(emoji: string): "bought" | "missed" | null {
  if (BOUGHT.has(emoji)) return "bought"
  if (MISSED.has(emoji)) return "missed"
  return null
}

/**
 * Apply the owner's tick to the claim they put it on.
 *
 * A tick buys that claim's whole quantity — someone who asked for two gets both.
 * If only one of their two was found, the stepper in the shop screen is the
 * right tool; a reaction cannot carry a number.
 *
 * Returns false when the reaction was not the owner's to give, which is the
 * common case: customers react to each other's messages all day.
 */
export async function applyOwnerReaction(input: {
  reactorJid: string
  messageId: string
  emoji: string
}): Promise<boolean> {
  const intent = classifyOwnerReaction(input.emoji)
  if (intent === null) return false
  if (!(await isBotAdmin(senderNumber(input.reactorJid)))) return false

  const [claim] = await sql`
    SELECT id, quantity FROM wa_claims
    WHERE message_id = ${input.messageId} AND state <> 'rejected'
    ORDER BY id ASC
  `
  if (!claim) return false

  await markClaimObtained(
    claim.id as number,
    intent === "bought" ? (claim.quantity as number) : 0,
  )
  if (intent === "missed") {
    await sql`UPDATE wa_claims SET state = 'rejected', updated_at = NOW() WHERE id = ${claim.id}`
  }
  return true
}

/**
 * Which reaction a claim should now carry, or null to leave it alone.
 *
 * Zero obtained is not a cross. Before the owner reaches the shop every claim
 * has obtained zero, and telling forty customers they missed out because nobody
 * has gone shopping yet would be worse than saying nothing.
 */
export function outcomeFor(claim: {
  quantity: number
  obtained: number
  state: string
}): string | null {
  if (claim.state === "rejected") return OUTCOME_REACTIONS.missed
  if (claim.obtained > 0) return OUTCOME_REACTIONS.secured
  return null
}
