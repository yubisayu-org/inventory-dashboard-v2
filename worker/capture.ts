import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { downloadMediaMessage } from "baileys"
import type { WAMessage, WASocket } from "baileys"
import { hueHistogram, loadRgb, safePenHues } from "@/lib/claims"
import { createPost, findPostByMessage } from "@/lib/db/claims"
import { currentCapture, isBotAdmin } from "@/lib/db/whatsapp-groups"
import { uploadPostImage } from "@/lib/storage"
import { decodable } from "@/lib/whatsapp/heic"
import sql from "@/lib/db-pool"
import { quietLogger } from "./logger"
import { senderNumber } from "./handle-command"

/** Working width for the hue histogram. Only proportions matter. */
const HISTOGRAM_WIDTH = 240

/**
 * Longest edge a stored shelf may have.
 *
 * A photo sent through WhatsApp arrives about 1280 across and is kept as-is. A
 * photo sent as a file arrives at whatever the camera shot — 3000, 4000 — which
 * is worth having for the price tags and not worth storing whole: every render
 * reads the original and Supabase charges for egress.
 *
 * 3000 after reading tags at 2000 and finding them almost legible. It puts a
 * naming crop at about 630 real pixels against WhatsApp's 269, for roughly
 * 1.8 MB a shelf. Going further is the camera's job: a tag that is thirty
 * pixels tall in the frame does not become readable by storing more of the
 * shelf around it.
 */
const MAX_STORED_EDGE = 3000

/**
 * JPEG quality for a shelf that had to be re-encoded.
 *
 * Measured against real price tags across four parts of one shelf: readable at
 * 60, and the saving is nearly all spent by 70 — 88 to 75 sheds 600 KB, 75 to
 * 60 only another 200, because a shelf photograph is mostly fine detail that
 * does not compress further. 70 sits a notch above where legibility was still
 * fine, so a darker or noisier rack has somewhere to fall.
 */
const STORED_QUALITY = 70

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

  // decodable, not the raw download: a shelf sent as a file from an iPhone is
  // HEIC, which sharp cannot read at all. Everything below assumes bytes it can
  // open.
  const buffer = await decodable((await downloadMediaMessage(
    input.message,
    "buffer",
    {},
    { logger: quietLogger, reuploadRequest: input.sock.updateMediaMessage },
  )) as Buffer)

  // sharp reads a path, and the resolver library takes paths throughout, so the
  // bytes touch disk once here rather than the library growing a second entry
  // point for buffers.
  const dir = await mkdtemp(join(tmpdir(), "wa-post-"))
  const scratch = join(dir, "post.jpg")
  try {
    await writeFile(scratch, buffer)
    const raster = await loadRgb(scratch, HISTOGRAM_WIDTH)
    const hues = safePenHues(hueHistogram(raster), raster.width * raster.height).map((c) => c.hue)

    // The photograph's own size, not the histogram's. raster is a 240px-wide
    // downscale that exists only to count colours, and storing its dimensions
    // described every shelf as 240 pixels across — harmless while nothing read
    // the columns, and a trap for the first thing that did.
    const shot = await sharp(scratch).metadata()
    const oversized = Math.max(shot.width ?? 0, shot.height ?? 0) > MAX_STORED_EDGE

    // Re-encoded only when it has to be. A photo that arrived through WhatsApp
    // is already small and is stored byte for byte, because a second JPEG pass
    // over an image that has had one only loses more.
    const stored = oversized
      ? await sharp(scratch)
          .resize({ width: MAX_STORED_EDGE, height: MAX_STORED_EDGE, fit: "inside" })
          .jpeg({ quality: STORED_QUALITY })
          .toBuffer()
      : buffer
    const size = oversized ? await sharp(stored).metadata() : shot

    const path = `${event}/${input.messageId}.jpg`
    await uploadPostImage(path, stored, "image/jpeg")

    const { id } = await createPost({
      event,
      imagePath: path,
      imageWidth: size.width ?? 0,
      imageHeight: size.height ?? 0,
      store: capture.store,
      // Country comes from the event, which is where a trip's currency lives.
      countryId: await countryForEvent(event),
      // Left to follow the WhatsApp setting rather than copying it now. A shelf
      // captured this morning and a setting changed this afternoon should agree
      // when the shelf is finally named tonight.
      pricingMethod: null,
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
