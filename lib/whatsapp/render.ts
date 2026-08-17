import sharp from "sharp"
import sql from "@/lib/db-pool"
import { getPost, listSlots, type WaSlot } from "@/lib/db/claims"
import { localPostImage } from "./post-image"

/** Width the picture is rendered at. Wide enough to read on a phone, small
 *  enough to send over a mobile connection in a shop. */
export const SHOPPING_LIST_WIDTH = 900

const DONE = "#16a34a"
const PARTIAL = "#f59e0b"
const OPEN = "#dc2626"

const tone = (claimed: number, bought: number) =>
  bought >= claimed ? DONE : bought > 0 ? PARTIAL : OPEN

/** SVG text is not HTML, and a customer's label can contain anything. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

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

const ROW_HEIGHT = 40
const LIST_HEADER = 44
const LIST_PADDING = 16

/** One line per SKU, under the photo. Sizes are their own lines, indented. */
function listRow(slot: WaSlot, index: number, width: number, top: number, indent: boolean): string {
  const left = slot.claimed - slot.bought
  const colour = tone(slot.claimed, slot.bought)
  const name = escapeXml(slot.label || `SKU ${index + 1}`)
  const action = left === 0 ? "done" : `buy ${left}`

  const marker = indent
    ? `<rect x="60" y="${top + 6}" width="4" height="18" rx="2" fill="${colour}"/>`
    : `<circle cx="34" cy="${top + 13}" r="13" fill="${colour}"/>`
  // An indented row sits directly under the name it belongs to, so repeating
  // that name would only push the size — the one thing the row exists to say —
  // further from the eye.
  const title = indent
    ? `<text x="76" y="${top + 21}" font-size="22" fill="#4b5563">size ${escapeXml(slot.size) || "—"}</text>`
    : `<text x="60" y="${top + 21}" font-size="24" font-weight="600" fill="#111827">${name}${slot.size ? ` · ${escapeXml(slot.size)}` : ""}</text>`

  return `
    ${marker}
    ${title}
    <text x="${width - 150}" y="${top + 21}" text-anchor="end" font-size="22"
          fill="#9ca3af">${slot.bought}/${slot.claimed}</text>
    <text x="${width - 24}" y="${top + 21}" text-anchor="end" font-size="23" font-weight="700"
          fill="${colour}">${action}</text>`
}

/**
 * The picture the owner shops from, and the one /rekap posts.
 *
 * Badges say what to grab; the list under the photo carries the detail badges
 * have no room for — which SKU, which size, and the name once one has been
 * typed. Two SKU at one position share a badge position by design: they hang on
 * the same peg, so their two lines in the list are what tells them apart.
 */
export async function renderShoppingList(postId: number): Promise<Buffer> {
  const post = await getPost(postId)
  if (post === null) throw new Error(`no such post: ${postId}`)

  const slots = await listSlots(postId)
  const photo = sharp(await localPostImage(post.imagePath)).resize({ width: SHOPPING_LIST_WIDTH })
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

  // A split item gets a heading line plus one line per size; everything else
  // gets a single line.
  const byLabel = new Map<string, WaSlot[]>()
  for (const slot of slots) {
    const key = slot.label || `#${slot.id}`
    byLabel.set(key, [...(byLabel.get(key) ?? []), slot])
  }
  const lines: { slot: WaSlot; indent: boolean }[] = []
  for (const group of byLabel.values()) {
    if (group.length === 1) {
      lines.push({ slot: group[0], indent: false })
    } else {
      const total: WaSlot = {
        ...group[0],
        size: "",
        claimed: group.reduce((n, s) => n + s.claimed, 0),
        bought: group.reduce((n, s) => n + s.bought, 0),
      }
      lines.push({ slot: total, indent: false })
      for (const slot of group) lines.push({ slot, indent: true })
    }
  }

  const listHeight = LIST_HEADER + lines.length * ROW_HEIGHT + LIST_PADDING
  let y = height + LIST_HEADER
  const rows = lines
    .map(({ slot, indent }, i) => {
      const row = listRow(slot, i, width, y, indent)
      y += ROW_HEIGHT
      return row
    })
    .join("")

  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + listHeight}">
      <style>text { font-family: Helvetica, Arial, "DejaVu Sans", sans-serif; }</style>
      ${badges}
      <rect x="0" y="${height}" width="${width}" height="${listHeight}" fill="#ffffff"/>
      <text x="24" y="${height + 30}" font-size="20" font-weight="700" fill="#6b7280"
            letter-spacing="1.5">WHAT TO BUY · ${slots.length} SKU</text>
      ${rows}
    </svg>`,
  )

  return sharp(base)
    .extend({ bottom: listHeight, background: "#ffffff" })
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
    SELECT s.point_x, s.point_y, p.image_path
    FROM wa_slots s JOIN wa_posts p ON p.id = s.post_id
    WHERE s.id = ${slotId}
  `
  if (!row || row.point_x === null || row.point_y === null) return null

  const file = await localPostImage(row.image_path as string)
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
  const out = Math.min(box * 2, 1000)

  return sharp(file)
    .extract({ left, top, width: box, height: box })
    .resize({ width: out })
    .sharpen()
    .jpeg({ quality: 88 })
    .toBuffer()
}
