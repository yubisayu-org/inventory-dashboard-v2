import sharp from "sharp"
import sql from "@/lib/db-pool"
import { getPost, listSlots, type WaSlot } from "@/lib/db/claims"
import { localShelfImage } from "./post-image"

/** Width the picture is rendered at. Wide enough to read on a phone, small
 *  enough to send over a mobile connection in a shop. */
export const SHOPPING_LIST_WIDTH = 900

const DONE = "#16a34a"
const PARTIAL = "#f59e0b"
const OPEN = "#dc2626"

const tone = (claimed: number, bought: number) =>
  bought >= claimed ? DONE : bought > 0 ? PARTIAL : OPEN

/**
 * One badge per SKU: how many are STILL TO BUY, not how many were claimed.
 *
 * That is the number the owner acts on while holding a basket — "4/5" needs a
 * subtraction first. The bought-of-claimed figure stays, smaller, underneath.
 */
/**
 * Badge size relative to the original drawing.
 *
 * Halved at the owner's request: the first size hid the product it marked, and
 * on a shelf this dense a badge that covers the item defeats the purpose of
 * putting it on the photograph at all.
 */
const BADGE_SCALE = 0.5

function badge(slot: WaSlot, cx: number, cy: number): string {
  const left = slot.claimed - slot.bought
  const colour = tone(slot.claimed, slot.bought)

  const r = Math.round(40 * BADGE_SCALE)
  const digit = Math.round((left === 0 ? 34 : 40) * BADGE_SCALE)
  const stroke = Math.max(2, Math.round(5 * BADGE_SCALE))

  // The pill keeps its original size while the circle shrinks. The circle sits
  // on the product and had to get out of its way; the pill hangs below on shelf
  // edging, blocks nothing, and is the harder of the two to read — shrinking it
  // would cost legibility to solve a problem it never had.
  const pillW = 88
  const pillH = 26
  const pillFont = 18

  return `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${colour}" stroke="#fff" stroke-width="${stroke}"/>
    <text x="${cx}" y="${cy + digit * 0.35}" text-anchor="middle" font-size="${digit}"
          font-weight="700" fill="#fff">${left === 0 ? "✓" : left}</text>
    <rect x="${cx - pillW / 2}" y="${cy + r + 2}" width="${pillW}" height="${pillH}"
          rx="${pillH / 2}" fill="#111827" fill-opacity="0.82"/>
    <text x="${cx}" y="${cy + r + 2 + pillH * 0.72}" text-anchor="middle" font-size="${pillFont}"
          font-weight="600" fill="#fff">${slot.bought} of ${slot.claimed}</text>`
}

/**
 * The picture the owner shops from, and the one /rekap posts.
 *
 * Badges only. A written list under the photo was tried and dropped: on a shelf
 * of unnamed SKU every line repeated its own badge — same count, same colour,
 * beside a name no better than "SKU 3" — and cost half the screen to say it.
 * The detail a badge cannot hold (size, name, who claimed it) lives on the tally
 * screen, which is open in the other hand while shopping.
 *
 * Two SKU at one position therefore share one badge, showing their combined
 * count: they hang on the same peg, so one number and one grab is the truth on
 * the shop floor. Splitting them by size is the tally screen's job.
 */
export async function renderShoppingList(postId: number): Promise<Buffer> {
  const post = await getPost(postId)
  if (post === null) throw new Error(`no such post: ${postId}`)

  const slots = await listSlots(postId)
  const photo = sharp(await localShelfImage(post)).resize({ width: SHOPPING_LIST_WIDTH })
  const base = await photo.toBuffer()
  const { width = SHOPPING_LIST_WIDTH, height = 0 } = await sharp(base).metadata()

  // Slots sharing a position share a badge, so it is drawn once for the group.
  const drawn = new Set<string>()
  const badges = slots
    .filter((s) => s.point !== null)
    .map((slot) => {
      const point = slot.point as { x: number; y: number }
      const key = `${point.x.toFixed(3)}|${point.y.toFixed(3)}`
      if (drawn.has(key)) return ""
      drawn.add(key)
      const together = slots.filter(
        (s) => s.point !== null && `${s.point.x.toFixed(3)}|${s.point.y.toFixed(3)}` === key,
      )
      const merged: WaSlot = {
        ...slot,
        claimed: together.reduce((n, s) => n + s.claimed, 0),
        bought: together.reduce((n, s) => n + s.bought, 0),
      }
      return badge(merged, point.x * width, point.y * height)
    })
    .join("")

  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <style>text { font-family: Helvetica, Arial, "DejaVu Sans", sans-serif; }</style>
      ${badges}
    </svg>`,
  )

  return sharp(base)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 82 })
    .toBuffer()
}

/**
 * Share of the photo's shorter side a slot crop covers.
 *
 * Wide enough to include the neighbours, because "the bear one, second from the
 * left" is how these get named, and a crop tight enough to hold only the item
 * takes away the very context that identifies it.
 */
const CROP_SHARE = 0.28

/**
 * A close-up of one slot, for naming it.
 *
 * The shopping list draws a badge over each slot, which is right in a shop —
 * the number has to be readable at arm's length — and wrong at a laptop, where
 * the badge covers the product being described. So the naming screen gets the
 * photograph underneath, uncovered, cropped to the item in question.
 *
 * A slot with no position has no close-up: nothing is known about where it is,
 * which is exactly why it is in review.
 */
export async function renderSlotCrop(slotId: number, share = CROP_SHARE): Promise<Buffer | null> {
  const [row] = await sql`
    SELECT s.point_x, s.point_y, p.image_path, p.view_path, p.archived_at
    FROM wa_slots s JOIN wa_posts p ON p.id = s.post_id
    WHERE s.id = ${slotId}
  `
  if (!row || row.point_x === null || row.point_y === null) return null

  const file = await localShelfImage({
    imagePath: row.image_path as string,
    viewPath: (row.view_path as string) ?? "",
    archivedAt: row.archived_at ? String(row.archived_at) : null,
  })
  const meta = await sharp(file).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (!width || !height) return null

  // Tighter than a tenth of the frame is finer than the photograph resolves;
  // wider than two thirds is the whole shelf again.
  const bounded = Math.min(0.66, Math.max(0.1, share))
  const box = Math.round(Math.min(width, height) * bounded)

  // Clamped so a slot near an edge yields a full-size crop that slides inward
  // rather than a sliver, which would be harder to recognise than no crop.
  const left = Math.max(0, Math.min(width - box, Math.round(Number(row.point_x) * width - box / 2)))
  const top = Math.max(0, Math.min(height - box, Math.round(Number(row.point_y) * height - box / 2)))

  // Upscaled at most twofold. A price tag is a handful of pixels on a shelf
  // photograph, and enlarging past what the sensor recorded makes it blurrier
  // rather than more legible — the honest answer to "I cannot read it" is a
  // tighter crop, not a bigger one.
  //
  // The 1400 ceiling exists for shelves sent as files, which carry enough real
  // pixels that the old 1000 was throwing detail away at the tightest zoom
  // step. A WhatsApp photo never reaches it: twice its crop is smaller.
  const out = Math.min(box * 2, 1400)

  // The ring is dropped once the crop is tight enough to be unambiguous.
  //
  // It exists to say which of several things in shot is this one, which is a
  // question a wide crop raises and a close one answers by itself. Kept at every
  // step it did the opposite: at the closest zoom it covered the price tag the
  // owner had zoomed in to read.
  const ringed = bounded > 0.2

  // A ring on the item this crop is about.
  //
  // The crop deliberately includes the neighbours, which is what makes two
  // adjacent slots look like the same picture — a tenth of a frame apart, they
  // share most of their view. The ring says which of the things in shot is
  // this one.
  //
  // Hollow and thin on purpose: a filled badge would cover the product, which
  // is the mistake the shopping-list badge already had to be shrunk for.
  const ringX = Math.round(Number(row.point_x) * width) - left
  const ringY = Math.round(Number(row.point_y) * height) - top
  const scale = out / box
  const ringR = Math.round(box * 0.16 * scale)
  const ring = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${out}" height="${out}">
      <circle cx="${Math.round(ringX * scale)}" cy="${Math.round(ringY * scale)}" r="${ringR}"
              fill="none" stroke="#ffffff" stroke-width="${Math.max(2, Math.round(ringR * 0.14))}"
              opacity="0.9"/>
      <circle cx="${Math.round(ringX * scale)}" cy="${Math.round(ringY * scale)}" r="${ringR}"
              fill="none" stroke="#dc2626" stroke-width="${Math.max(1, Math.round(ringR * 0.08))}"/>
    </svg>`,
  )

  const crop = sharp(file)
    .extract({ left, top, width: box, height: box })
    .resize({ width: out })
    .sharpen()

  return (ringed ? crop.composite([{ input: ring, top: 0, left: 0 }]) : crop)
    .jpeg({ quality: 88 })
    .toBuffer()
}
