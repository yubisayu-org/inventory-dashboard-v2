import sql from "@/lib/db-pool"
import type { DBExecutor } from "./actor"

export interface ReplyItem {
  id: number
  groupJid: string
  quotedMessageId: string
  /** The customer's own number — who the synthetic quoted message's
   *  contextInfo.participant must be, not the group. See migration 082. */
  participant: string
  reaction: string
  text: string
}

export async function queueReaction(
  groupJid: string,
  quotedMessageId: string,
  reaction: string,
  participant: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO wa_replies (group_jid, quoted_message_id, reaction, participant)
    VALUES (${groupJid}, ${quotedMessageId}, ${reaction}, ${participant})
  `
}

export async function queueText(
  groupJid: string,
  quotedMessageId: string,
  text: string,
  participant: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO wa_replies (group_jid, quoted_message_id, text, participant)
    VALUES (${groupJid}, ${quotedMessageId}, ${text}, ${participant})
  `
}

/**
 * The next queued reply, oldest first — atomically CLAIMED (moved to
 * 'sending'), not merely read.
 *
 * Same overlapping-sweep hazard as lib/db/outbox.ts's nextPending: the
 * reply sweep (worker/replies.ts) runs on a setInterval, and a plain
 * `SELECT ... WHERE state = 'pending'` would let two overlapping sweeps
 * both pick up and re-send the same queued reaction/text. Locking the row
 * inside the subquery with FOR UPDATE SKIP LOCKED and flipping its state in
 * the same statement makes the claim atomic.
 */
export async function nextPendingReply(db: DBExecutor = sql): Promise<ReplyItem | null> {
  const [row] = await db`
    UPDATE wa_replies SET state = 'sending'
    WHERE id = (
      SELECT id FROM wa_replies WHERE state = 'pending' ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `
  if (!row) return null
  return {
    id: row.id as number,
    groupJid: row.group_jid as string,
    quotedMessageId: row.quoted_message_id as string,
    participant: (row.participant as string | undefined) ?? "",
    reaction: row.reaction as string,
    text: row.text as string,
  }
}

export async function markReplySent(id: number, db: DBExecutor = sql): Promise<void> {
  await db`UPDATE wa_replies SET state = 'sent', sent_at = NOW() WHERE id = ${id}`
}

export async function markReplyFailed(id: number, reason: string, db: DBExecutor = sql): Promise<void> {
  await db`UPDATE wa_replies SET state = 'failed', error = ${reason.slice(0, 500)} WHERE id = ${id}`
}

/**
 * Reset rows a dead process abandoned mid-claim back to 'pending'.
 * See lib/db/outbox.ts's resetStrandedSending — same hazard, same fix,
 * kept separate because the two queues have separate tables.
 */
export async function resetStrandedSending(db: DBExecutor = sql): Promise<void> {
  await db`UPDATE wa_replies SET state = 'pending' WHERE state = 'sending'`
}
