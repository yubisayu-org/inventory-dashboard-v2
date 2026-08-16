import { loadRgb } from "./raster"
import { hueHistogram, safePenHues } from "./hue"
import { detectMarks, type Mark } from "./ink"
import { detectChanges } from "./diff"
import { locateInPost, type Located } from "./locate"

export { loadRgb, loadGray, loadGrayWithin, loadRgbWithin, rgbToHsv } from "./raster"
export type { RgbRaster, GrayRaster } from "./raster"
export { hueHistogram, safePenHues, PEN_COLOURS, HUE_BUCKETS } from "./hue"
export { detectMarks, blobsFromMask } from "./ink"
export { detectChanges, DIFF_WIDTH } from "./diff"
export type { Mark, Point } from "./ink"
export { locateInPost } from "./locate"
export type { Located, Region } from "./locate"
export { parseVariantNote, resolveText } from "./text"
export type { Variant, TextClaim } from "./text"
export { classifyAnswer } from "./answer"
export type { Verdict } from "./answer"
export { clusterPoints, DEFAULT_CLUSTER_RADIUS } from "./cluster"
export type { Cluster } from "./cluster"
export { normalizeSize } from "./size"

export type ImageReply =
  /** `via` says which detector fired — worth knowing when a result looks wrong,
   *  because the two fail for completely different reasons. */
  | { kind: "marks"; marks: Mark[]; via: "hue" | "difference" }
  | { kind: "crop"; located: Located }
  | { kind: "repost"; located: Located }
  | { kind: "unresolved" }

/** Working width for mark detection. Strokes are large; detail is not needed. */
const REPLY_W = 480
/** Working width for the histogram. Only proportions matter here. */
const POST_W = 240

/**
 * Decide what an image reply is claiming.
 *
 * Ink is tested first because a marked photo is unambiguous: the customer
 * pointed at something. A reply with marks is usually also a whole-frame match
 * against the post, and reporting that instead would throw away the only part
 * that says WHICH item.
 *
 * Difference against the post is the second attempt, for the case that broke
 * this in the field: a shelf whose own colours exclude every pen but one.
 *
 * Trusted hues come from the post itself — see safePenHues. Passing a hue the
 * photo contains would return the photo's own contents as marks.
 */
export async function resolveImageReply(
  postPath: string,
  replyPath: string,
): Promise<ImageReply> {
  const post = await loadRgb(postPath, POST_W)
  const hues = safePenHues(hueHistogram(post), post.width * post.height).map((c) => c.hue)

  const reply = await loadRgb(replyPath, REPLY_W)
  const marks = detectMarks(reply, hues)
  if (marks.length > 0) return { kind: "marks", marks, via: "hue" }

  // Hue detection needs a colour the photograph does not contain, and a real
  // shop shelf can leave only one — signage, packaging and price tags between
  // them cover most of the wheel. When it finds nothing, ask what CHANGED
  // instead, which works whatever pen the customer reached for.
  //
  // Second rather than first because it needs the reply to be the same image
  // marked up: a customer who photographs their screen defeats it, while hue
  // detection still reads their ink.
  const changed = await detectChanges(postPath, replyPath)
  if (changed.length > 0) return { kind: "marks", marks: changed, via: "difference" }

  const located = await locateInPost(postPath, replyPath)
  if (located === null) return { kind: "unresolved" }
  return located.kind === "repost" ? { kind: "repost", located } : { kind: "crop", located }
}
