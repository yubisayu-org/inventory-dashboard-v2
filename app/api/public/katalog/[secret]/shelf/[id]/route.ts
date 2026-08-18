import { NextResponse } from "next/server"
import sharp from "sharp"
import sql from "@/lib/db-pool"
import { eventForSecret } from "@/lib/katalog/secret"
import { localPostImage } from "@/lib/whatsapp/post-image"

type Params = { params: Promise<{ secret: string; id: string }> }

/** Long edge a customer's copy is served at. Enough to read a price tag. */
const VIEW_EDGE = 2250

/**
 * One shelf, encoded for a phone.
 *
 * AVIF at quality 40: the same pixels as the stored JPEG for about a fifth of
 * the bytes, measured against real price tags. That ratio is the whole reason
 * this route exists — a catalogue is one file read by many people, which is
 * exactly where paying CPU to save bandwidth is worth it.
 *
 * Served from this origin rather than straight from the bucket, so the canvas
 * the customer draws on is same-origin and can be exported. A cross-origin
 * image taints the canvas and toBlob throws, which would fail at the very last
 * step — after she has drawn her circle.
 *
 * Encoded per request in this prototype. Before this carries traffic the AVIF
 * belongs beside the original in storage, written once at capture.
 */
export async function GET(_req: Request, { params }: Params) {
  const { secret, id } = await params
  try {
    const events = await sql`SELECT name FROM events WHERE is_active ORDER BY name`
    const event = eventForSecret(secret, events.map((r) => r.name as string))
    if (event === null) return new NextResponse("Not found", { status: 404 })

    // Scoped to the trip the secret unlocks: a shelf id from another event must
    // not be readable by editing the number in the URL.
    const [post] = await sql`
      SELECT image_path FROM wa_posts WHERE id = ${Number(id)} AND event = ${event}
    `
    if (!post) return new NextResponse("Not found", { status: 404 })

    const file = await localPostImage(post.image_path as string)
    const body = await sharp(file)
      .resize({ width: VIEW_EDGE, height: VIEW_EDGE, fit: "inside", withoutEnlargement: true })
      .avif({ quality: 40 })
      .toBuffer()

    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "image/avif",
        // A shelf photograph never changes once posted, so this is the one
        // header that decides the bill: each device fetches a shelf once.
        "Cache-Control": "public, max-age=31536000, immutable",
        // Same-origin already, but explicit so a future move to a bucket does
        // not silently break canvas export.
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (err) {
    console.error("Failed to render catalogue shelf:", err)
    return new NextResponse("Failed", { status: 500 })
  }
}
