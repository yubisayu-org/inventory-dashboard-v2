import type { Point } from "./ink"

export interface Cluster {
  centre: Point
  /** Indices into the array passed to clusterPoints. */
  members: number[]
}

/**
 * How close two marks must be to mean the same item, in normalized units.
 *
 * Roughly a tenth of the frame's shorter side: wide enough that two people
 * ticking the same pyjama set agree, narrow enough that neighbouring items on a
 * packed shelf stay apart. Shelves vary, so callers may override it — and the
 * annotated photo is where a wrong choice becomes visible and correctable.
 */
export const DEFAULT_CLUSTER_RADIUS = 0.06

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Group claim positions into slots.
 *
 * Leader-based rather than transitive: each cluster is anchored to a seed point
 * and only admits points within the radius OF THAT SEED. Transitive grouping —
 * where A joins B, B joins C, so A and C share a slot — chains along a row of
 * evenly-spaced items and swallows the whole shelf into one slot.
 *
 * Seeds are taken in input order, and callers pass marks largest-first, so the
 * most confident mark anchors each slot.
 */
export function clusterPoints(points: Point[], radius = DEFAULT_CLUSTER_RADIUS): Cluster[] {
  const taken = new Array<boolean>(points.length).fill(false)
  const clusters: Cluster[] = []

  for (let i = 0; i < points.length; i++) {
    if (taken[i]) continue
    taken[i] = true
    const members = [i]

    for (let j = i + 1; j < points.length; j++) {
      if (taken[j]) continue
      if (distance(points[i], points[j]) <= radius) {
        taken[j] = true
        members.push(j)
      }
    }

    let sumX = 0
    let sumY = 0
    for (const m of members) {
      sumX += points[m].x
      sumY += points[m].y
    }

    clusters.push({
      centre: { x: sumX / members.length, y: sumY / members.length },
      members,
    })
  }

  return clusters.sort((a, b) => b.members.length - a.members.length)
}
