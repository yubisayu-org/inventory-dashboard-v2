import { loadRgb } from "./raster"
import { hueHistogram, safePenHues } from "./hue"
import { detectMarks, type Mark } from "./ink"
import { locateInPost, type Located } from "./locate"

export { loadRgb, loadGray, loadGrayWithin, rgbToHsv } from "./raster"
export type { RgbRaster, GrayRaster } from "./raster"
export { hueHistogram, safePenHues, PEN_COLOURS, HUE_BUCKETS } from "./hue"
export { detectMarks } from "./ink"
export type { Mark, Point } from "./ink"
export { locateInPost } from "./locate"
export type { Located, Region } from "./locate"
export { parseVariantNote, resolveText } from "./text"
export type { Variant, TextClaim } from "./text"
export { classifyAnswer } from "./answer"
export type { Verdict } from "./answer"
export { clusterPoints, DEFAULT_CLUSTER_RADIUS } from "./cluster"
export type { Cluster } from "./cluster"

export type ImageReply =
  | { kind: "marks"; marks: Mark[] }
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
  if (marks.length > 0) return { kind: "marks", marks }

  const located = await locateInPost(postPath, replyPath)
  if (located === null) return { kind: "unresolved" }
  return located.kind === "repost" ? { kind: "repost", located } : { kind: "crop", located }
}
