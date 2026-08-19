import { loadGray, loadGrayWithin, type GrayRaster } from "./raster"
import type { Point } from "./ink"

export interface Region {
  x: number
  y: number
  w: number
  h: number
}

export interface Located {
  region: Region
  centre: Point
  /** Normalized correlation of the winning position, 0..1. */
  score: number
  /** Best score at a position well away from the winner — the ambiguity check. */
  runnerUp: number
  /**
   * "repost" when the match covers essentially the whole frame: the customer
   * sent the photo back rather than cropping, so the image says WHICH POST and
   * the caption says what they want. "crop" when it covers a region, which is
   * itself the claim.
   */
  kind: "crop" | "repost"
}

/** Scene width for the search. Coarse deliberately — this locates, it does not inspect. */
const SCENE_W = 260
/**
 * Template widths swept, as a fraction of scene width.
 *
 * The sweep must reach 1.0. A customer who sends the whole photo back matches
 * only at the scene's own size, and stopping short of it — as an earlier
 * version did at 0.92 — makes that claim shape undetectable rather than merely
 * less confident.
 */
const MIN_SCALE = 0.12
const MAX_SCALE = 1
const SCALE_STEP = 0.04
/** Below this the "match" is a coincidence of texture. */
const SCORE_FLOOR = 0.7
/** At or above this share of the frame, the reply is the whole photo. */
const REPOST_COVERAGE = 0.6

/**
 * A fixed lattice of sample points over the template.
 *
 * Full-pixel correlation is needlessly expensive here and changes no decision:
 * we are locating a hand-sized region, not registering pixels. A few hundred
 * samples is enough to separate the right position from every other one.
 */
function lattice(w: number, h: number, target = 360): number[][] {
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / target)))
  const points: number[][] = []
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) points.push([x, y])
  }
  return points
}

interface Placement {
  score: number
  runnerUp: number
  ox: number
  oy: number
  tw: number
  th: number
}

/** Best normalized-correlation placement of one template size within the scene. */
function bestPlacement(scene: GrayRaster, template: GrayRaster): Placement | null {
  // Equal sizes are allowed: that is exactly the whole-photo-sent-back case,
  // where the only candidate offset is (0, 0).
  if (template.width > scene.width || template.height > scene.height) return null

  const points = lattice(template.width, template.height)

  let templateMean = 0
  for (const [x, y] of points) templateMean += template.data[y * template.width + x]
  templateMean /= points.length

  let templateVariance = 0
  for (const [x, y] of points) {
    const d = template.data[y * template.width + x] - templateMean
    templateVariance += d * d
  }
  const templateSd = Math.sqrt(templateVariance)
  // A flat template correlates with everything equally; refuse to guess.
  if (templateSd === 0) return null

  let best: Placement | null = null
  let runnerUp = -1

  for (let oy = 0; oy + template.height <= scene.height; oy++) {
    for (let ox = 0; ox + template.width <= scene.width; ox++) {
      let sceneMean = 0
      for (const [x, y] of points) sceneMean += scene.data[(oy + y) * scene.width + ox + x]
      sceneMean /= points.length

      let covariance = 0
      let sceneVariance = 0
      for (const [x, y] of points) {
        const sv = scene.data[(oy + y) * scene.width + ox + x] - sceneMean
        const tv = template.data[y * template.width + x] - templateMean
        covariance += sv * tv
        sceneVariance += sv * sv
      }

      const denominator = Math.sqrt(sceneVariance) * templateSd
      const score = denominator === 0 ? 0 : covariance / denominator

      // The runner-up only counts if it is a genuinely different position.
      // Neighbouring offsets score nearly as well as the winner by construction,
      // and treating those as competition would call every match ambiguous.
      const farFromBest =
        best === null ||
        Math.abs(best.ox - ox) > template.width / 2 ||
        Math.abs(best.oy - oy) > template.height / 2

      if (best === null || score > best.score) {
        if (best !== null && farFromBest && best.score > runnerUp) runnerUp = best.score
        best = { score, runnerUp, ox, oy, tw: template.width, th: template.height }
      } else if (farFromBest && score > runnerUp) {
        runnerUp = score
      }
    }
  }

  // A full-size template has exactly one candidate offset, so no runner-up
  // exists. Report 0 rather than the sentinel, so callers can subtract it.
  return best === null ? null : { ...best, runnerUp: Math.max(0, runnerUp) }
}

/**
 * Find where a reply image sits inside the post it replies to.
 *
 * A crop is an exact sub-rectangle of a known image, so this is template
 * matching rather than recognition — no model, no per-claim cost. Scale is
 * unknown (customers zoom before cropping, and WhatsApp resizes), so the search
 * sweeps template sizes and keeps the best.
 *
 * The correlation score doubles as confidence: a wide margin over the runner-up
 * means one position clearly won, while a narrow one means repeated stock or a
 * crop showing only fabric texture, and the claim belongs in review.
 */
export async function locateInPost(postPath: string, replyPath: string): Promise<Located | null> {
  const scene = await loadGray(postPath, SCENE_W)

  // Built as a list rather than a float-accumulating loop: repeatedly adding
  // 0.04 overshoots 1.0 by a rounding error and silently drops the full-frame
  // scale, which is the one the repost case depends on.
  const scales: number[] = []
  for (let step = 0; ; step++) {
    const scale = MIN_SCALE + step * SCALE_STEP
    if (scale > MAX_SCALE + 1e-9) break
    scales.push(Math.min(scale, MAX_SCALE))
  }

  let best: Placement | null = null
  for (const scale of scales) {
    const template = await loadGrayWithin(
      replyPath,
      Math.round(scene.width * scale),
      Math.round(scene.height * scale),
    )
    const placement = bestPlacement(scene, template)
    if (placement !== null && (best === null || placement.score > best.score)) best = placement
  }

  if (best === null || best.score < SCORE_FLOOR) return null

  const region: Region = {
    x: best.ox / scene.width,
    y: best.oy / scene.height,
    w: best.tw / scene.width,
    h: best.th / scene.height,
  }

  return {
    region,
    centre: { x: region.x + region.w / 2, y: region.y + region.h / 2 },
    score: best.score,
    runnerUp: best.runnerUp,
    kind: region.w * region.h >= REPOST_COVERAGE ? "repost" : "crop",
  }
}
