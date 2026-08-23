import sharp from "sharp"
import sql from "@/lib/db-pool"
import { uploadCatalogueImage } from "@/lib/storage"

/**
 * Long edge of the copy customers browse.
 *
 * Two thirds of the stored original, which measured against real price tags is
 * the point where legibility stops improving faster than the file grows.
 */
export const VIEW_EDGE = 2250

/**
 * Quality of that copy.
 *
 * AVIF at 40 carries the same pixels as the stored JPEG for about a fifth of
 * the bytes — 1.6 MB becomes 230 KB — with tags still readable. The codec is
 * worth its CPU here and nowhere else in this app: one file, read by many
 * people, over their mobile data and against our egress bill.
 */
const VIEW_QUALITY = 40

/** Where a shelf's catalogue copy lives, derived from the original's path. */
export function viewPathFor(imagePath: string): string {
  return `${imagePath.replace(/\.[^./]+$/, "")}.avif`
}

/** Encode one shelf for the catalogue. Pure, so it can be tested on a fixture. */
export async function encodeView(file: string | Buffer): Promise<Buffer> {
  return sharp(file)
    .resize({ width: VIEW_EDGE, height: VIEW_EDGE, fit: "inside", withoutEnlargement: true })
    .avif({ quality: VIEW_QUALITY })
    .toBuffer()
}

/**
 * Write a shelf's catalogue copy and remember where it went.
 *
 * Called at capture, so the page serves a file rather than encoding one per
 * request — and so a closed trip can drop its originals with the catalogue
 * still standing.
 *
 * Failure is not fatal to capturing a shelf: a rack recorded without its
 * customer-facing copy is a rack that can be shopped, named and invoiced, and
 * the copy can be written later. Losing the whole capture because AVIF encoding
 * failed would be the worse trade.
 */
export async function writeCatalogueCopy(postId: number, imagePath: string, file: string | Buffer) {
  try {
    const path = viewPathFor(imagePath)
    await uploadCatalogueImage(path, await encodeView(file))
    await sql`UPDATE wa_posts SET view_path = ${path}, updated_at = NOW() WHERE id = ${postId}`
    return path
  } catch (err) {
    console.error(`failed to write the catalogue copy of post ${postId}:`, err)
    return ""
  }
}
