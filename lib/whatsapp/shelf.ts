import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import sql from "@/lib/db-pool"
import { hueHistogram, loadRgb, safePenHues } from "@/lib/claims"
import { createPost } from "@/lib/db/claims"
import { uploadPostImage } from "@/lib/storage"
import { writeCatalogueCopy } from "./catalogue"
import { decodable } from "./heic"

/** Working width for the hue histogram. Only proportions matter. */
const HISTOGRAM_WIDTH = 240

/**
 * Longest edge a stored shelf may have.
 *
 * A photo that came through WhatsApp arrives about 1280 across and is kept as
 * it is. One uploaded from the dashboard arrives at whatever the camera shot —
 * 3000, 4000 — which is worth having for the price tags and not worth storing
 * whole: every render reads the original and Supabase charges for egress.
 *
 * 3000 after reading tags at 2000 and finding them almost legible. It puts a
 * naming crop at about 630 real pixels against WhatsApp's 269. Going further is
 * the camera's job: a tag thirty pixels tall in the frame does not become
 * readable by storing more of the shelf around it.
 */
export const MAX_STORED_EDGE = 3000

/**
 * JPEG quality for a shelf that had to be re-encoded.
 *
 * Measured against real price tags across four parts of one shelf: readable at
 * 60, and the saving is nearly all spent by 70 — 88 to 75 sheds 600 KB, 75 to
 * 60 only another 200, because a rack photograph is mostly fine detail that
 * does not compress further.
 */
export const STORED_QUALITY = 70

/**
 * Record a shelf, however it arrived.
 *
 * One road for both doors: a photo sent to the group and captured by the
 * worker, and a file uploaded in the dashboard. They differ in what they know
 * about the sender and nothing else, so everything downstream — hue analysis,
 * downscaling, the catalogue copy, the row — belongs here rather than twice.
 *
 * The safe pen hues are computed once and stored on the post. Every reply is
 * then judged against the same answer instead of each one recomputing it and
 * possibly disagreeing.
 */
export async function storeShelf(input: {
  event: string
  store: string
  note: string
  /** The image as it arrived. HEIC is fine; it is decoded here. */
  body: Buffer
  /** Bucket key. The caller decides, because the two doors name files
   *  differently: a WhatsApp message id, or a random name for an upload. */
  path: string
  messageId?: string
  groupJid?: string
}): Promise<{ id: number; width: number; height: number; bytes: number }> {
  const buffer = await decodable(input.body)

  // sharp reads a path, and the resolver library takes paths throughout, so the
  // bytes touch disk once here rather than the library growing a second entry
  // point for buffers.
  const dir = await mkdtemp(join(tmpdir(), "wa-shelf-"))
  const scratch = join(dir, "shelf.jpg")
  try {
    await writeFile(scratch, buffer)
    const raster = await loadRgb(scratch, HISTOGRAM_WIDTH)
    const hues = safePenHues(hueHistogram(raster), raster.width * raster.height).map((c) => c.hue)

    const shot = await sharp(scratch).metadata()
    const oversized = Math.max(shot.width ?? 0, shot.height ?? 0) > MAX_STORED_EDGE

    // Re-encoded only when it has to be: a second JPEG pass over an image that
    // has already had one only loses more.
    const stored = oversized
      ? await sharp(scratch)
          .resize({ width: MAX_STORED_EDGE, height: MAX_STORED_EDGE, fit: "inside" })
          .jpeg({ quality: STORED_QUALITY })
          .toBuffer()
      : buffer
    const size = oversized ? await sharp(stored).metadata() : shot

    await uploadPostImage(input.path, stored, "image/jpeg")

    const { id } = await createPost({
      event: input.event,
      imagePath: input.path,
      imageWidth: size.width ?? 0,
      imageHeight: size.height ?? 0,
      store: input.store,
      // Country comes from the event, which is where a trip's currency lives.
      countryId: await countryForEvent(input.event),
      // Left to follow the WhatsApp setting rather than copying it now. A shelf
      // captured this morning and a setting changed this afternoon should agree
      // when the shelf is finally named tonight.
      pricingMethod: null,
      note: input.note,
      safeHues: hues,
      messageId: input.messageId ?? "",
      groupJid: input.groupJid ?? "",
    })

    // The copy customers browse, written now rather than per request — and the
    // one that outlives the original when the trip is archived.
    await writeCatalogueCopy(id, input.path, stored)

    return { id, width: size.width ?? 0, height: size.height ?? 0, bytes: stored.length }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The event's country, or null. Naming refuses without one, and says so. */
export async function countryForEvent(event: string): Promise<number | null> {
  const [row] = await sql`SELECT country_id FROM events WHERE name = ${event}`
  return (row?.country_id as number | null) ?? null
}
