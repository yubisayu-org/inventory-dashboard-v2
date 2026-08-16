import { blobsFromMask, type Mark } from "./ink"
import { loadRgbWithin } from "./raster"

/**
 * Working width for comparison. Small enough that JPEG noise averages away,
 * large enough that a circle round one pyjama set is still several hundred
 * pixels.
 */
export const DIFF_WIDTH = 480

/**
 * How different a pixel must be to count as changed, 0..255 per channel.
 *
 * WhatsApp re-encodes every image it carries, so the same photo round-tripped
 * twice differs everywhere by a little. This sits well above that floor and
 * below any deliberate pen stroke.
 */
const CHANNEL_THRESHOLD = 60

/**
 * Largest share of the frame that may change and still be read as marks.
 *
 * Above this the two images are not the same photograph — a different shot of
 * the same shelf, a screen photographed rather than screenshotted, a crop. The
 * difference is then meaningless and returning it would scatter claims at
 * random, so the caller falls back to matching by position instead.
 */
const MAX_CHANGED_SHARE = 0.25

/**
 * Find what the customer drew, by comparing their reply against the post.
 *
 * The hue detector asks "is this pixel pen-coloured", which needs a colour the
 * photograph does not already contain. On a real shop shelf — signage, packets,
 * price tags — that can leave a single usable colour, and a customer marking in
 * any other is invisible.
 *
 * This asks a different question: what is not in the original? That works
 * whatever colour they used, at the cost of needing the reply to be the same
 * image marked up rather than a fresh photograph. Both detectors are kept
 * because they fail in different situations — this one on a re-photographed
 * screen, the other on a colourful shelf.
 *
 * Returns an empty array rather than guessing when the two images cannot be
 * compared: different shapes, or so much changed that they are not the same
 * picture.
 */
export async function detectChanges(
  postPath: string,
  replyPath: string,
  minPixels?: number,
): Promise<Mark[]> {
  // Fitted into the same box rather than resized to the same width, so a reply
  // that came back at a different aspect ratio is caught by the size check
  // below instead of being silently stretched into alignment.
  const post = await loadRgbWithin(postPath, DIFF_WIDTH, DIFF_WIDTH)
  const reply = await loadRgbWithin(replyPath, DIFF_WIDTH, DIFF_WIDTH)

  if (post.width !== reply.width || post.height !== reply.height) return []

  const { width: w, height: h } = post
  const mask = new Uint8Array(w * h)
  let changed = 0

  for (let i = 0, p = 0; i < post.data.length; i += 3, p++) {
    const dr = Math.abs(post.data[i] - reply.data[i])
    const dg = Math.abs(post.data[i + 1] - reply.data[i + 1])
    const db = Math.abs(post.data[i + 2] - reply.data[i + 2])
    // Max channel rather than an average: a red stroke over a red-ish product
    // barely moves the mean while moving one channel a long way.
    if (Math.max(dr, dg, db) >= CHANNEL_THRESHOLD) {
      mask[p] = 1
      changed++
    }
  }

  if (changed / (w * h) > MAX_CHANGED_SHARE) return []

  return blobsFromMask(mask, w, h, minPixels)
}
