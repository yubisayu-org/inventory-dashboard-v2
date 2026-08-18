import { downloadMediaMessage } from "baileys"
import type { WAMessage, WASocket } from "baileys"
import { findPostByMessage } from "@/lib/db/claims"
import { currentCapture, isBotAdmin } from "@/lib/db/whatsapp-groups"
import { storeShelf } from "@/lib/whatsapp/shelf"
import sql from "@/lib/db-pool"
import { quietLogger } from "./logger"
import { senderNumber } from "./handle-command"

/**
 * Turn a photo the owner sent into a post — if it was one.
 *
 * Three things all have to hold, and returning null for any of them is the
 * normal case rather than an error: the sender is on the admin list, a capture
 * window is open for this group, and the group is bound to an event. That is
 * the whole of what `/mulai` bought — no marker typed per photo, and an
 * ordinary snapshot sent to the group stays an ordinary snapshot.
 *
 * The safe pen hues are computed here, once, and stored on the post. Every reply
 * is then judged against the same answer, rather than each one recomputing it
 * and possibly disagreeing.
 */
export async function capturePost(input: {
  sock: WASocket
  message: WAMessage
  groupJid: string
  messageId: string
  sender: string
  caption: string
}): Promise<number | null> {
  // The same message can arrive twice — once live, once as catch-up after a
  // reconnect. Without this a flaky connection quietly doubles the shelf.
  if (await findPostByMessage(input.groupJid, input.messageId)) return null

  const capture = await currentCapture(input.groupJid)
  if (capture === null) return null
  if (!(await isBotAdmin(senderNumber(input.sender)))) return null

  const [group] = await sql`SELECT event FROM wa_groups WHERE jid = ${input.groupJid}`
  const event = (group?.event as string | null) ?? null
  if (!event) return null

  const buffer = (await downloadMediaMessage(
    input.message,
    "buffer",
    {},
    { logger: quietLogger, reuploadRequest: input.sock.updateMediaMessage },
  )) as Buffer

  // Everything past the download is the same work an upload does, so it lives
  // in one place: HEIC decoding, hue analysis, downscaling, the catalogue copy.
  const { id } = await storeShelf({
    event,
    store: capture.store,
    note: input.caption,
    body: buffer,
    path: `${event}/${input.messageId}.jpg`,
    messageId: input.messageId,
    groupJid: input.groupJid,
  })
  return id
}

