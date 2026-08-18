import type { WASocket } from "baileys"
import { nextPending, markSent, markFailed } from "@/lib/db/outbox"
import { localPostImage } from "@/lib/whatsapp/post-image"

/** How often the worker looks for a shelf to post. */
export const OUTBOX_INTERVAL_MS = 5000

/**
 * Post one waiting shelf, if there is one.
 *
 * Sent as an ordinary photo, at the size it was stored — WhatsApp does not
 * recompress what the bot uploads, because media is end-to-end encrypted and
 * the shrinking everyone knows is the sender's phone app doing it before
 * upload. So a rack uploaded in the dashboard reaches the group at full
 * camera resolution, with an inline preview, which the owner cannot achieve
 * sending it from their own phone.
 *
 * One at a time, on a timer, rather than a burst: forty racks arriving in one
 * second reads as spam to both the group and to WhatsApp.
 *
 * Returns whether anything was sent, so the caller can decide to come back
 * sooner when the queue is busy.
 */
export async function sendNextShelf(sock: WASocket): Promise<boolean> {
  const item = await nextPending()
  if (item === null) return false

  try {
    const file = await localPostImage(item.imagePath)
    const caption = [item.store, item.note].filter(Boolean).join(" · ")
    const sent = await sock.sendMessage(item.groupJid, { image: { url: file }, caption })

    const messageId = sent?.key?.id ?? ""
    if (!messageId) throw new Error("sent, but WhatsApp returned no message id")

    await markSent(item.id, item.postId, messageId, item.groupJid)
    return true
  } catch (err) {
    // Marked failed rather than retried forever: a rack that cannot be sent is
    // usually a bad file or a group the bot has been removed from, and neither
    // improves by being attempted every five seconds.
    await markFailed(item.id, (err as Error).message)
    console.error(`failed to post shelf ${item.postId}:`, err)
    return true
  }
}
