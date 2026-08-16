import sharp from "sharp"

/** Decoded pixels, row-major, 3 bytes per pixel. */
export interface RgbRaster {
  data: Uint8Array
  width: number
  height: number
}

/** Decoded luminance, row-major, 1 byte per pixel. */
export interface GrayRaster {
  data: Uint8Array
  width: number
  height: number
}

/**
 * Decode an image to raw RGB at a working width.
 *
 * Every resolver works on a downscaled copy: pen strokes and shelf items are
 * large features, and full resolution would cost seconds per claim while
 * changing no answer. Height follows the source aspect ratio — replies arrive
 * at whatever size WhatsApp chose, so nothing may assume a shape.
 */
export async function loadRgb(path: string, width: number): Promise<RgbRaster> {
  const { data, info } = await sharp(path)
    .resize({ width })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), width: info.width, height: info.height }
}

/** Luminance-only decode, for the shape-matching resolvers where colour is noise. */
export async function loadGray(path: string, width: number): Promise<GrayRaster> {
  const { data, info } = await sharp(path)
    .greyscale()
    .resize({ width })
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), width: info.width, height: info.height }
}

/**
 * RGB to HSV. Hue in degrees, saturation and value in 0..1.
 *
 * Hue and saturation are what separate pen ink from photographed goods: pen is
 * a narrow hue at extreme saturation, while dyed fabric under shop lighting is
 * neither. RGB distance cannot express that, which is why this conversion
 * exists rather than thresholding channels directly.
 */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const chroma = max - min

  const v = max / 255
  const s = max === 0 ? 0 : chroma / max

  // Undefined hue for greys; 0 is as good as any other answer and avoids a NaN
  // escaping into the callers' comparisons.
  if (chroma === 0) return { h: 0, s, v }

  let h: number
  if (max === r) h = 60 * (((g - b) / chroma) % 6)
  else if (max === g) h = 60 * ((b - r) / chroma + 2)
  else h = 60 * ((r - g) / chroma + 4)

  return { h: h < 0 ? h + 360 : h, s, v }
}
