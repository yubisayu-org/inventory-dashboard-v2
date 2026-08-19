import type { WASocket } from "baileys"
import { nextPendingReply, markReplySent, markReplyFailed } from "@/lib/db/replies"

/** How often the worker looks for a dashboard action waiting to reach the group. */
export const REPLY_INTERVAL_MS = 3000

/**
 * Deliver one queued reaction or text reply, if there is one.
 *
 * Builds a synthetic WAMessageKey from the stored group/message id — the
 * same construction ReactionQueue already relies on for a live reaction, so
 * this is proven to work without the original WAMessage object in hand.
 */
export async function sendNextReply(sock: WASocket): Promise<boolean> {
  const item = await nextPendingReply()
  if (item === null) return false

  const key = { remoteJid: item.groupJid, id: item.quotedMessageId, fromMe: false }

  try {
    if (item.reaction) {
      await sock.sendMessage(item.groupJid, { react: { text: item.reaction, key } })
    } else {
      await sock.sendMessage(item.groupJid, { text: item.text }, { quoted: { key, message: {} } })
    }
    await markReplySent(item.id)
    return true
  } catch (err) {
    await markReplyFailed(item.id, (err as Error).message)
    console.error(`failed to send queued reply ${item.id}:`, err)
    return true
  }
}
