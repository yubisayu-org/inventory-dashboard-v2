import { resolveImageReply, clusterPoints, type Point } from "@/lib/claims"
import { addClaim, getPost, listClaims, setSlots } from "@/lib/db/claims"

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

  const result = await resolveImageReply(post.imagePath, input.replyPath)
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
      for (const mark of result.marks) await record("ink", mark.point, 1, "pending")
      break
    case "crop": {
      // The margin over the runner-up is the confidence that matters: a narrow
      // one means repeated stock, and the owner should look.
      const margin = result.located.score - result.located.runnerUp
      await record("crop", result.located.centre, margin, margin > 0.15 ? "pending" : "review")
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

  const positioned = claims.filter((c) => c.point !== null && c.state !== "rejected")
  const clusters = clusterPoints(positioned.map((c) => c.point as Point))

  const positional = clusters.map((cluster) => ({
    point: cluster.centre,
    variantId: null as string | null,
    claimIds: cluster.members.map((i) => positioned[i].id),
  }))

  // Variant claims have no position, so they group by variant id instead.
  const byVariant = new Map<string, number[]>()
  for (const claim of claims) {
    if (claim.variantId === null || claim.state === "rejected") continue
    const list = byVariant.get(claim.variantId) ?? []
    list.push(claim.id)
    byVariant.set(claim.variantId, list)
  }
  const variantSlots = [...byVariant.entries()].map(([variantId, claimIds]) => ({
    point: null,
    variantId,
    claimIds,
  }))

  await setSlots(postId, [...positional, ...variantSlots])
}
