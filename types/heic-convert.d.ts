// heic-convert ships no types. Only the one call this codebase makes is
// declared, rather than a speculative transcription of the whole surface.
declare module "heic-convert" {
  interface ConvertOptions {
    buffer: Buffer | Uint8Array
    format: "JPEG" | "PNG"
    /** 0..1, JPEG only. */
    quality?: number
  }
  function convert(options: ConvertOptions): Promise<ArrayBuffer>
  export default convert
}
