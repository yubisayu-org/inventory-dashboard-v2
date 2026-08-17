import {
  resolveImageReply, clusterPoints, normalizeSize, DEFAULT_CLUSTER_RADIUS, type Point,
} from "@/lib/claims"
import { addClaim, getPost, listClaims, listRecentPosts, setSlots, type WaPost } from "@/lib/db/claims"
import { detectChanges, loadRgbWithin } from "@/lib/claims"
import { localPostImage } from "./post-image"

/**
 * How far a crop must beat the next-best position to be trusted with one.
 *
 * Measured on the fixtures: a genuine crop cleared its runner-up by about 0.30,
 * while an ambiguous match on real shelf photos came in around 0.01.
 */
const CROP_MARGIN = 0.15

/**
 * Turn a customer's image reply into claims.
 *
 * The resolver decides what kind of reply it is; this function only records the
 * outcome. A marked photo yields one claim per mark, because a customer who
 * ticks three things is claiming three things. A crop yields one. A whole photo
 * sent back yields none on its own — the image only says WHICH POST, and the
 * caption carries the request, which is a text claim rather than a positional
 * one and is handled by the caller.
 *
 * Anything the resolver cannot place is still recorded, in review state. A
 * claim that reaches nobody is worse than one the owner has to look at.
 */
export async function ingestImageReply(input: {
  postId: number
  sender: string
  messageId: string
  replyPath: string
  caption: string
}): Promise<{ claimIds: number[] }> {
  const post = await getPost(input.postId)
  if (post === null) throw new Error(`no such post: ${input.postId}`)

  // What this sender already claims on this post, so a resend does not double
  // their order. Customers repeat themselves when an acknowledgement is slow,
  // and the spec's rule is that a bare repeat adds nothing — it is the same
  // request, sent twice, not a request for two.
  const alreadyClaimed = (await listClaims(input.postId))
    .filter((c) => c.sender === input.sender && c.state !== "rejected" && c.point !== null)
    .map((c) => c.point as Point)

  const isRepeat = (point: Point) =>
    alreadyClaimed.some(
      (seen) => Math.hypot(seen.x - point.x, seen.y - point.y) <= DEFAULT_CLUSTER_RADIUS,
    )

  // image_path is a bucket key, not a file path — the resolver needs the latter.
  const postFile = await localPostImage(post.imagePath)
  const result = await resolveImageReply(postFile, input.replyPath)
  const claimIds: number[] = []

  const record = async (
    source: "ink" | "crop" | "repost" | "manual",
    point: Point | null,
    confidence: number,
    state: "pending" | "review",
  ) => {
    const { id } = await addClaim({
      postId: input.postId,
      sender: input.sender,
      customer: null,
      source,
      point,
      variantId: null,
      quantity: 1,
      note: input.caption,
      confidence,
      state,
      messageId: input.messageId,
    })
    claimIds.push(id)
  }

  switch (result.kind) {
    case "marks":
      for (const mark of result.marks) {
        // Same person, same spot, already recorded. Skipped rather than stored
        // and reconciled later: a duplicate that exists is a duplicate that can
        // reach the shopping list.
        if (isRepeat(mark.point)) continue
        await record("ink", mark.point, 1, "pending")
        alreadyClaimed.push(mark.point)
      }
      break
    case "crop": {
      // The margin over the runner-up is the confidence that matters, not the
      // raw score: a shelf of near-identical pyjamas produces several good
      // matches, and the winner among them is close to arbitrary.
      const margin = result.located.score - result.located.runnerUp
      const confident = margin > CROP_MARGIN

      // Below the margin the position is dropped rather than stored. Recording
      // one anyway would put a badge on the wrong item, and the owner shops from
      // that picture — a claim with no position asks a question, a claim with
      // the wrong one gives a wrong answer.
      await record(
        "crop",
        confident ? result.located.centre : null,
        margin,
        confident ? "pending" : "review",
      )
      break
    }
    case "repost":
      // Position-free: the image identified the post, nothing more.
      await record("repost", null, 1, "review")
      break
    case "unresolved":
      await record("manual", null, 0, "review")
      break
  }

  await recluster(input.postId)
  return { claimIds }
}

/**
 * Recompute this post's slots from its claims.
 *
 * Runs after every ingest rather than on a schedule, so the shopping list is
 * correct the moment a claim lands. setSlots carries forward the tally and the
 * named product, so this is safe to call as often as it likes.
 */
export async function recluster(postId: number): Promise<void> {
  const claims = await listClaims(postId)
  const live = claims.filter((c) => c.state !== "rejected")

  const positioned = live.filter((c) => c.point !== null)
  const clusters = clusterPoints(positioned.map((c) => c.point as Point))

  // A cluster is a place on the shelf. What is bought there may still be two
  // different things, so each cluster splits again by the size its claims name.
  // The centre stays the cluster's, not the sub-group's: both sizes hang on the
  // same peg, and moving one badge sideways would only make the picture lie.
  const positional = clusters.flatMap((cluster) => {
    const bySize = new Map<string, number[]>()
    for (const index of cluster.members) {
      const claim = positioned[index]
      const size = normalizeSize(claim.note)
      const list = bySize.get(size) ?? []
      list.push(claim.id)
      bySize.set(size, list)
    }
    return [...bySize.entries()].map(([size, claimIds]) => ({
      point: cluster.centre,
      variantId: null as string | null,
      size,
      claimIds,
    }))
  })

  // Variant claims have no position, so they group by variant id instead. The
  // variant already IS the size, so nothing is read out of the note here.
  const byVariant = new Map<string, number[]>()
  for (const claim of live) {
    if (claim.variantId === null) continue
    const list = byVariant.get(claim.variantId) ?? []
    list.push(claim.id)
    byVariant.set(claim.variantId, list)
  }
  const variantSlots = [...byVariant.entries()].map(([variantId, claimIds]) => ({
    point: null,
    variantId,
    size: "",
    claimIds,
  }))

  await setSlots(postId, [...positional, ...variantSlots])
}

/**
 * Work out which shelf a customer marked, when they did not reply to it.
 *
 * Replying is the reliable way to say which photo you mean, and it is also a
 * habit rather than a reflex — customers crop or scribble on a shelf and fire it
 * off. Until now those landed nowhere at all: no claim, no reaction, and someone
 * convinced they had ordered.
 *
 * Difference detection answers this for free. Subtracting the reply from the
 * wrong shelf yields either nothing or a frame full of change, both of which it
 * refuses; subtracting it from the right one yields their pen strokes. So the
 * post that produces marks IS the post they marked, and finding it and reading
 * it are the same operation.
 *
 * Newest first, and the first match wins. Two shelves similar enough to both
 * match are two photographs of the same rack, where either answer puts the claim
 * in the same place.
 */
export async function matchPostByImage(
  groupJid: string,
  replyPath: string,
): Promise<{ post: WaPost; marks: Awaited<ReturnType<typeof detectChanges>> } | null> {
  for (const post of await listRecentPosts(groupJid)) {
    // image_path is a bucket key; the detector needs a file. Cached after the
    // first reply, so scanning several shelves costs one download each at most.
    const file = await localPostImage(post.imagePath).catch(() => null)
    if (file === null) continue

    const marks = await detectChanges(file, replyPath).catch(() => [])
    if (marks.length > 0) return { post, marks }

    // Why a candidate was rejected is the only useful thing to know when a
    // customer insists they sent the right picture. Shapes differing means they
    // cropped it or sent a screenshot of the chat rather than the photo.
    if (process.env.WA_DEBUG) {
      const [a, b] = await Promise.all([
        loadRgbWithin(file, 480, 480).catch(() => null),
        loadRgbWithin(replyPath, 480, 480).catch(() => null),
      ])
      console.log("[wa] no match", {
        post: post.id,
        postShape: a ? `${a.width}x${a.height}` : "?",
        replyShape: b ? `${b.width}x${b.height}` : "?",
        sameShape: Boolean(a && b && a.width === b.width && a.height === b.height),
      })
    }
  }
  return null
}
