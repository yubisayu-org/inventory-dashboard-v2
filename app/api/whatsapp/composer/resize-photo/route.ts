import { NextRequest, NextResponse } from "next/server"
import sharp from "sharp"
import { requireSession, requireOwner } from "@/lib/api"
import { decodable } from "@/lib/whatsapp/heic"
import { MAX_STORED_EDGE, STORED_QUALITY } from "@/lib/whatsapp/shelf"

/**
 * Cap a composer photo to the same size a shelf gets — 3000px longest edge,
 * re-encoded at quality 70 only if it had to be shrunk — before it reaches
 * `uploadCatalogueMedia`.
 *
 * `storeShelf` (lib/whatsapp/shelf.ts) already does this resize, but it does
 * a lot more alongside it that a product-post photo has no use for: a hue
 * histogram for safe-pen-color detection, a `wa_posts` row, a catalogue AVIF
 * copy. Rather than drag a composer upload through that pipeline (or fork
 * its resize logic into a second copy), this route reuses the two pieces
 * that are actually generic — `decodable` (HEIC → JPEG) and the
 * MAX_STORED_EDGE/STORED_QUALITY constants/resize step — and returns the
 * bytes directly rather than uploading them.
 *
 * The client re-wraps this response's blob as the `file` field of the
 * existing `POST /api/sheets/catalogue-posts`, so that route's own
 * upload/DB-insert/orphan-cleanup logic stays the one path a catalogue post
 * is ever created through — this route never touches Storage or the DB.
 */
export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const form = await req.formData()
    const file = form.get("file")
    if (!(file instanceof File) || !file.type.startsWith("image/")) {
      return NextResponse.json({ error: "file must be an image" }, { status: 400 })
    }

    const original = Buffer.from(await file.arrayBuffer())
    const decoded = await decodable(original)
    const shot = await sharp(decoded).metadata()
    const oversized = Math.max(shot.width ?? 0, shot.height ?? 0) > MAX_STORED_EDGE

    // Re-encoded only when it has to be, same as storeShelf: a second JPEG
    // pass over an image that's already small only loses more.
    const [body, contentType] = oversized
      ? [
          await sharp(decoded)
            .resize({ width: MAX_STORED_EDGE, height: MAX_STORED_EDGE, fit: "inside" })
            .jpeg({ quality: STORED_QUALITY })
            .toBuffer(),
          "image/jpeg",
        ]
      : [decoded, decoded === original ? file.type : "image/jpeg"]

    return new NextResponse(new Uint8Array(body), { headers: { "Content-Type": contentType } })
  } catch (err) {
    console.error("Failed to resize composer photo:", err)
    return NextResponse.json({ error: "Failed to process photo" }, { status: 500 })
  }
}
