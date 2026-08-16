import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadMediaMessage } from "baileys"
import type { WAMessage, WASocket } from "baileys"
import { hueHistogram, loadRgb, safePenHues } from "@/lib/claims"
import { createPost, findPostByMessage } from "@/lib/db/claims"
import { getProductDefaults } from "@/lib/db/settings"
import { currentCapture, isBotAdmin } from "@/lib/db/whatsapp-groups"
import { uploadPostImage } from "@/lib/storage"
import sql from "@/lib/db-pool"
import { quietLogger } from "./logger"
import { senderNumber } from "./handle-command"

/** Working width for the hue histogram. Only proportions matter. */
const HISTOGRAM_WIDTH = 240

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

  // sharp reads a path, and the resolver library takes paths throughout, so the
  // bytes touch disk once here rather than the library growing a second entry
  // point for buffers.
  const dir = await mkdtemp(join(tmpdir(), "wa-post-"))
  const scratch = join(dir, "post.jpg")
  try {
    await writeFile(scratch, buffer)
    const raster = await loadRgb(scratch, HISTOGRAM_WIDTH)
    const hues = safePenHues(hueHistogram(raster), raster.width * raster.height).map((c) => c.hue)

    const path = `${event}/${input.messageId}.jpg`
    await uploadPostImage(path, buffer, "image/jpeg")

    const defaults = await getProductDefaults()
    const { id } = await createPost({
      event,
      imagePath: path,
      imageWidth: raster.width,
      imageHeight: raster.height,
      store: capture.store,
      // Country comes from the event, which is where a trip's currency lives.
      countryId: await countryForEvent(event),
      pricingMethod: defaults.whatsappPricingMethod,
      note: input.caption,
      safeHues: hues,
      messageId: input.messageId,
      groupJid: input.groupJid,
    })
    return id
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The event's country, or null. Naming refuses without one, and says so. */
async function countryForEvent(event: string): Promise<number | null> {
  const [row] = await sql`SELECT country_id FROM events WHERE name = ${event}`
  return (row?.country_id as number | null) ?? null
}
