import { rgbToHsv, type RgbRaster } from "./raster"

/** 10 degrees per bucket — finer than pen colours differ, coarser than JPEG noise. */
export const HUE_BUCKETS = 36

/**
 * A pixel counts toward the histogram only if it is *vivid*: both strongly
 * saturated and reasonably bright.
 *
 * These thresholds are what make the histogram mean "a colour that could be
 * confused with ink" rather than "a colour that appears". Dyed fabric,
 * packaging and shop shelving all sit below them; pen strokes sit far above.
 * Measured on the fixture: pen-green scores zero across the whole shelf.
 */
const VIVID_S = 0.35
const VIVID_V = 0.35

/**
 * WhatsApp's drawing palette, by hue.
 *
 * White and black pens are deliberately absent: they carry no hue, so they
 * cannot be told apart from highlights and shadow, which every photograph has.
 * A customer drawing in white or black lands in review.
 */
export const PEN_COLOURS = [
  { name: "red", hue: 0 },
  { name: "orange", hue: 30 },
  { name: "yellow", hue: 55 },
  { name: "green", hue: 130 },
  { name: "cyan", hue: 190 },
  { name: "blue", hue: 225 },
  { name: "purple", hue: 280 },
  { name: "pink", hue: 320 },
] as const

/** Vivid-pixel counts per 10-degree hue bucket. */
export function hueHistogram(raster: RgbRaster): number[] {
  const histogram = new Array<number>(HUE_BUCKETS).fill(0)
  for (let i = 0; i < raster.data.length; i += 3) {
    const { h, s, v } = rgbToHsv(raster.data[i], raster.data[i + 1], raster.data[i + 2])
    if (s < VIVID_S || v < VIVID_V) continue
    const bucket = Math.min(HUE_BUCKETS - 1, Math.floor(h / (360 / HUE_BUCKETS)))
    histogram[bucket]++
  }
  return histogram
}

/**
 * A pen colour is safe for a given post when the post itself has essentially
 * none of that hue, so any such pixel in a reply must be ink.
 *
 * The window is +/- 2 buckets (20 degrees either side) because JPEG chroma
 * subsampling smears hue at the edges of a stroke, and because customers do not
 * pick the exact palette entry the histogram was built around.
 *
 * The tolerance is proportional to frame size rather than absolute: a handful
 * of stray vivid pixels in a large photo is noise, but the same count in a
 * thumbnail is a real feature.
 */
export function safePenHues(
  histogram: number[],
  pixelCount: number,
): { name: string; hue: number }[] {
  const tolerance = pixelCount * 0.0002
  return PEN_COLOURS.filter(({ hue }) => {
    const centre = Math.floor(hue / (360 / HUE_BUCKETS))
    let nearby = 0
    for (let d = -2; d <= 2; d++) {
      nearby += histogram[(centre + d + HUE_BUCKETS) % HUE_BUCKETS]
    }
    return nearby <= tolerance
  }).map((c) => ({ name: c.name, hue: c.hue }))
}
