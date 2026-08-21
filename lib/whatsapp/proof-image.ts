import sharp from "sharp"

/** Same rendering approach as lib/whatsapp/render.ts's shopping list: an SVG
 *  string composited/rasterized by sharp, not a headless browser or a
 *  screenshot of anything — there is nothing to screenshot, this worker has
 *  no visual WhatsApp client, only the API. Styled to read like a real WA
 *  group chat screenshot (doodle wallpaper, avatar-beside-bubble, tail, date
 *  divider). The trip name is deliberately kept OUTSIDE the chat frame, in a
 *  plain caption strip below — real WhatsApp has no notion of it, and
 *  drawing it inside the bubble would misrepresent what she actually saw. */
const WIDTH = 560
const CHAT_SIDE_PADDING = 14
const AVATAR_R = 18
const BUBBLE_LEFT = CHAT_SIDE_PADDING + AVATAR_R * 2 + 8
const BUBBLE_MAX_WIDTH = WIDTH - BUBBLE_LEFT - CHAT_SIDE_PADDING
const FONT_SIZE = 18
const LINE_HEIGHT = 26
const NAME_FONT_SIZE = 15.5
const PHONE_FONT_SIZE = 14
const TIME_FONT_SIZE = 13
// Rough monospace-equivalent character budget for FONT_SIZE at
// BUBBLE_MAX_WIDTH — exact wrapping isn't the point, a proof image reading
// clearly is.
const CHARS_PER_LINE = 30

const CHAT_BG = "#EDE1D3"
const WALLPAPER_ICON = "#E2D3BE"
const BUBBLE_BG = "#ffffff"
const NAME_COLOR = "#159C6B"
const AVATAR_BG = "#159C6B"
const CAPTION_BG = "#FDF5EE"
const FONT_FAMILY = "Helvetica, Arial, sans-serif"

const TOP_PADDING = 18
const DATE_PILL_HEIGHT = 24
const BUBBLE_TOP_MARGIN = 14
const BOTTOM_CHAT_PADDING = 18

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Break on existing newlines first (a customer's message is often already
 *  multi-line), then word-wrap each of those to CHARS_PER_LINE. */
function wrapText(text: string): string[] {
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") { lines.push(""); continue }
    let current = ""
    for (const word of paragraph.split(" ")) {
      const candidate = current ? `${current} ${word}` : word
      if (candidate.length > CHARS_PER_LINE && current) {
        lines.push(current)
        current = word
      } else {
        current = candidate
      }
    }
    if (current) lines.push(current)
  }
  return lines
}

/** A faint, repeating scatter of simple line-icons standing in for
 *  WhatsApp's doodle wallpaper — not a pixel copy, just enough texture to
 *  read as "chat background" instead of a flat rectangle. */
function wallpaperPattern(): string {
  const shapes = [
    `<circle cx="10" cy="10" r="5" fill="none" stroke="${WALLPAPER_ICON}" stroke-width="1.5"/>`,
    `<rect x="46" y="30" width="9" height="9" fill="none" stroke="${WALLPAPER_ICON}" stroke-width="1.5"/>`,
    `<path d="M20 45 L26 38 L32 45" fill="none" stroke="${WALLPAPER_ICON}" stroke-width="1.5"/>`,
    `<path d="M50 8 L54 16 L46 16 Z" fill="none" stroke="${WALLPAPER_ICON}" stroke-width="1.5"/>`,
  ]
  return `
    <pattern id="wallpaper" x="0" y="0" width="64" height="64" patternUnits="userSpaceOnUse">
      ${shapes.join("\n")}
    </pattern>
  `
}

export interface ProofBubbleInput {
  customerHandle: string
  phone: string
  text: string
  event: string | null
  sentAt: Date
}

/** A WhatsApp-style chat bubble rendered from data already stored at receipt
 *  time (note/sender/created_at) — a presentable proof of what she wrote,
 *  not a new capture step. See resolveProductPostClaim/createDirectClaim,
 *  which already persist this before any "delete for everyone" could reach
 *  the bot. */
export async function renderProofBubble(input: ProofBubbleInput): Promise<Buffer> {
  const lines = wrapText(input.text)
  const bubbleTextHeight = lines.length * LINE_HEIGHT
  const NAME_ROW_HEIGHT = 38
  const TIMESTAMP_ROW_HEIGHT = 28
  const bubbleHeight = NAME_ROW_HEIGHT + bubbleTextHeight + TIMESTAMP_ROW_HEIGHT
  const chatHeight = TOP_PADDING + DATE_PILL_HEIGHT + BUBBLE_TOP_MARGIN + bubbleHeight + BOTTOM_CHAT_PADDING
  const height = chatHeight

  const timeStr = input.sentAt.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })
  const dateStr = input.sentAt.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })

  const bubbleTop = TOP_PADDING + DATE_PILL_HEIGHT + BUBBLE_TOP_MARGIN
  const avatarCy = bubbleTop + bubbleHeight - AVATAR_R

  const textLines = lines
    .map((line, i) => `<text x="${BUBBLE_LEFT + 12}" y="${bubbleTop + NAME_ROW_HEIGHT + FONT_SIZE + i * LINE_HEIGHT}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="#111">${escapeXml(line)}</text>`)
    .join("\n")

  const phoneX = BUBBLE_LEFT + BUBBLE_MAX_WIDTH - 12

  const datePillWidth = dateStr.length * 6.5 + 24
  const datePillX = (WIDTH - datePillWidth) / 2

  const svg = `
    <svg width="${WIDTH}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        ${wallpaperPattern()}
        <filter id="bubbleShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#000000" flood-opacity="0.18"/>
        </filter>
      </defs>

      <rect width="${WIDTH}" height="${height}" fill="${CAPTION_BG}"/>
      <rect x="0" y="0" width="${WIDTH}" height="${chatHeight}" fill="${CHAT_BG}"/>
      <rect x="0" y="0" width="${WIDTH}" height="${chatHeight}" fill="url(#wallpaper)"/>

      <rect x="${datePillX}" y="${TOP_PADDING}" width="${datePillWidth}" height="${DATE_PILL_HEIGHT}" rx="${DATE_PILL_HEIGHT / 2}" fill="#ffffff" fill-opacity="0.85"/>
      <text x="${WIDTH / 2}" y="${TOP_PADDING + DATE_PILL_HEIGHT / 2 + 4}" font-family="${FONT_FAMILY}" font-size="11.5" fill="#5c5347" text-anchor="middle">${escapeXml(dateStr)}</text>

      <circle cx="${CHAT_SIDE_PADDING + AVATAR_R}" cy="${avatarCy}" r="${AVATAR_R}" fill="${AVATAR_BG}"/>
      <text x="${CHAT_SIDE_PADDING + AVATAR_R}" y="${avatarCy + 5}" font-family="${FONT_FAMILY}" font-size="14" fill="#ffffff" text-anchor="middle" font-weight="700">${escapeXml(input.customerHandle.slice(0, 1).toUpperCase())}</text>

      <path
        d="
          M ${BUBBLE_LEFT + 7} ${bubbleTop}
          H ${BUBBLE_LEFT + BUBBLE_MAX_WIDTH - 7}
          A 7 7 0 0 1 ${BUBBLE_LEFT + BUBBLE_MAX_WIDTH} ${bubbleTop + 7}
          V ${bubbleTop + bubbleHeight - 7}
          A 7 7 0 0 1 ${BUBBLE_LEFT + BUBBLE_MAX_WIDTH - 7} ${bubbleTop + bubbleHeight}
          H ${BUBBLE_LEFT}
          L ${BUBBLE_LEFT - 9} ${bubbleTop + bubbleHeight - 5}
          L ${BUBBLE_LEFT} ${bubbleTop + bubbleHeight - 14}
          V ${bubbleTop + 7}
          A 7 7 0 0 1 ${BUBBLE_LEFT + 7} ${bubbleTop}
          Z
        "
        fill="${BUBBLE_BG}"
        filter="url(#bubbleShadow)"
      />
      <text x="${BUBBLE_LEFT + 12}" y="${bubbleTop + 24}" font-family="${FONT_FAMILY}" font-size="${NAME_FONT_SIZE}" fill="${NAME_COLOR}" font-weight="700">${escapeXml(input.customerHandle)}</text>
      <text x="${phoneX}" y="${bubbleTop + 24}" font-family="${FONT_FAMILY}" font-size="${PHONE_FONT_SIZE}" fill="#8a8a8a" text-anchor="end">${escapeXml(input.phone)}</text>
      ${textLines}
      <text x="${BUBBLE_LEFT + BUBBLE_MAX_WIDTH - 10}" y="${bubbleTop + bubbleHeight - 10}" font-family="${FONT_FAMILY}" font-size="${TIME_FONT_SIZE}" fill="#8a8a8a" text-anchor="end">${timeStr}</text>
    </svg>
  `

  return sharp(Buffer.from(svg)).png().toBuffer()
}
