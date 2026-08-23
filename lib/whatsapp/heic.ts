/**
 * Brands an ISO base media file uses to say "this holds HEIF images".
 *
 * An iPhone writes `heic` or `mif1`; a burst or Live Photo can write `msf1` or
 * `hevc`. Matched by brand rather than by file extension because WhatsApp
 * carries a document under whatever name the sender's phone gave it, and the
 * name is the one thing nobody checks.
 */
const HEIF_BRANDS = new Set([
  "heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1",
])

/** Whether these bytes are a HEIF/HEIC image rather than something sharp reads. */
export function isHeic(buffer: Buffer): boolean {
  // ftyp box: 4 bytes of length, "ftyp", then the brand.
  if (buffer.length < 12) return false
  if (buffer.toString("ascii", 4, 8) !== "ftyp") return false
  return HEIF_BRANDS.has(buffer.toString("ascii", 8, 12).toLowerCase())
}

/**
 * A shelf photographed on an iPhone and sent as a file, made readable.
 *
 * WhatsApp transcodes photos to JPEG on the way through, so this never comes up
 * for an ordinary send. A document is passed along untouched — which is the
 * whole point of sending one, since it is the only way a legible price tag
 * reaches the dashboard — and on an iPhone that means HEIC, which the bundled
 * sharp has no decoder for. It arrived, it was recognised, and it died in the
 * first resize: "Support for this compression format has not been built in".
 *
 * Decoded in JavaScript, which is slow — a second or so for a 12-megapixel
 * frame — and acceptable because it happens once per shelf, in a worker with
 * nothing else to do, rather than per request.
 *
 * Quality 0.92 rather than 1: the difference is invisible on a photograph and
 * the file is a third of the size, and this output is only an intermediate —
 * capture re-encodes it again at 2000px before storing.
 */
export async function heicToJpeg(buffer: Buffer): Promise<Buffer> {
  // Imported here rather than at module load: it pulls in a WASM-ish decoder
  // that nothing else in the process needs, and most shelves never reach this.
  const { default: convert } = await import("heic-convert")
  return Buffer.from(await convert({ buffer, format: "JPEG", quality: 0.92 }))
}

/**
 * The same bytes, or a JPEG of them when sharp cannot read them.
 *
 * Not decided on the brand alone. Some HEIC files this sharp build opens
 * happily and some it does not — the difference is the codec profile inside,
 * not anything visible in the header — and a JavaScript decode of a file sharp
 * could have read is a third of a second and a generation of quality thrown
 * away. So it asks sharp first, with a real decode rather than a metadata read:
 * the phone's file passed metadata and then failed at the first resize, which
 * is the moment pixels are actually wanted.
 */
export async function decodable(buffer: Buffer): Promise<Buffer> {
  if (!isHeic(buffer)) return buffer

  try {
    // Eight pixels is enough to prove the codec is there, and costs nothing.
    const sharp = (await import("sharp")).default
    await sharp(buffer).resize(8, 8, { fit: "fill" }).raw().toBuffer()
    return buffer
  } catch {
    return heicToJpeg(buffer)
  }
}
