import { rgbToHsv, type RgbRaster } from "./raster"

/** A position on an image, normalized so it survives WhatsApp's resizing. */
export interface Point {
  x: number
  y: number
}

export interface Mark {
  point: Point
  /** Size of the blob, in working-resolution pixels. Bigger is more confident. */
  pixels: number
}

/** How far from a trusted hue a pixel may sit and still count as that ink. */
const HUE_TOLERANCE = 25
const INK_S = 0.35
const INK_V = 0.35

/** Below this, a blob is compression noise rather than a deliberate stroke. */
const DEFAULT_MIN_PIXELS = 40

function isInk(h: number, s: number, v: number, hues: number[]): boolean {
  if (s < INK_S || v < INK_V) return false
  return hues.some((hue) => {
    // Hue is circular: red at 0 and red at 355 are five degrees apart, not 355.
    // Shifting by 540 before the modulo keeps the arithmetic correct for
    // negative differences without a branch.
    const distance = Math.abs(((h - hue + 540) % 360) - 180)
    return distance <= HUE_TOLERANCE
  })
}

/**
 * Locate pen marks in a reply image.
 *
 * Works on the reply ALONE. Nothing here compares against the original, so
 * there is no registration step — which matters because replies come back
 * resized, re-encoded, and sometimes cropped, and aligning two such images
 * would be the hardest part of this whole system.
 *
 * `hues` must come from safePenHues() for the post being replied to. Passing a
 * hue the photo itself contains will return that photo's own contents as marks.
 */
export function detectMarks(
  raster: RgbRaster,
  hues: number[],
  minPixels: number = DEFAULT_MIN_PIXELS,
): Mark[] {
  const { width: w, height: h, data } = raster
  const mask = new Uint8Array(w * h)

  for (let i = 0, p = 0; i < data.length; i += 3, p++) {
    const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2])
    if (isInk(hsv.h, hsv.s, hsv.v, hues)) mask[p] = 1
  }

  // Connected components, 8-neighbour. An explicit stack rather than recursion:
  // a long stroke is thousands of pixels deep and would overflow the call stack.
  const seen = new Uint8Array(w * h)
  const marks: Mark[] = []
  const stack: number[] = []

  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue
    stack.length = 0
    stack.push(start)
    seen[start] = 1

    let count = 0
    let sumX = 0
    let sumY = 0

    while (stack.length > 0) {
      const p = stack.pop() as number
      const x = p % w
      const y = (p / w) | 0
      count++
      sumX += x
      sumY += y

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const q = ny * w + nx
          if (mask[q] && !seen[q]) {
            seen[q] = 1
            stack.push(q)
          }
        }
      }
    }

    if (count >= minPixels) {
      marks.push({ point: { x: sumX / count / w, y: sumY / count / h }, pixels: count })
    }
  }

  return marks.sort((a, b) => b.pixels - a.pixels)
}
