import sql from "@/lib/db-pool"
import type { DBExecutor } from "./actor"

export interface ReplyItem {
  id: number
  groupJid: string
  quotedMessageId: string
  reaction: string
  text: string
}

export async function queueReaction(
  groupJid: string,
  quotedMessageId: string,
  reaction: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO wa_replies (group_jid, quoted_message_id, reaction)
    VALUES (${groupJid}, ${quotedMessageId}, ${reaction})
  `
}

export async function queueText(
  groupJid: string,
  quotedMessageId: string,
  text: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO wa_replies (group_jid, quoted_message_id, text)
    VALUES (${groupJid}, ${quotedMessageId}, ${text})
  `
}

export async function nextPendingReply(db: DBExecutor = sql): Promise<ReplyItem | null> {
  const [row] = await db`
    SELECT * FROM wa_replies WHERE state = 'pending' ORDER BY id ASC LIMIT 1
  `
  if (!row) return null
  return {
    id: row.id as number,
    groupJid: row.group_jid as string,
    quotedMessageId: row.quoted_message_id as string,
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
