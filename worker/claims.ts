import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadMediaMessage } from "baileys"
import type { WAMessage, WASocket } from "baileys"
import sql from "@/lib/db-pool"
import { normalizeSize } from "@/lib/claims"
import { addClaim, findPostByMessage, listClaims, type WaPost } from "@/lib/db/claims"
import { ingestImageReply, recluster } from "@/lib/whatsapp/ingest"
import { resolveImageReply } from "@/lib/claims"
import { getPost } from "@/lib/db/claims"
import { resolveSenders } from "@/lib/whatsapp/identity"
import { quietLogger } from "./logger"
import { CAPTURE_REACTIONS } from "./reactions"

/**
 * Record what a customer's reply is claiming, and say which reaction it earned.
 *
 * An image reply goes through the resolver — marks, a crop, or the whole photo
 * sent back. A text reply is a claim only when it names something the photo
 * cannot show, which for a shelf means a size; anything else is chatter, and
 * reacting to chatter would train customers that the bot reads everything.
 *
 * Nothing is ever dropped for being unreadable. 😢 is a request to retype, and
 * the claim behind it is still recorded in review so the owner can rescue it.
 */
export async function captureClaim(input: {
  sock: WASocket
  message: WAMessage
  post: WaPost
  sender: string
  messageId: string
  text: string
  isImage: boolean
}): Promise<string | null> {
  // Same reason as capturePost: a redelivered message must not become a second
  // order for the same customer.
  const [seen] = await sql`
    SELECT 1 FROM wa_claims WHERE message_id = ${input.messageId} LIMIT 1
  `
  if (seen) return null

  if (input.isImage) return captureImageClaim(input)

  const size = normalizeSize(input.text)
  if (!size) return null

  await addClaim({
    postId: input.post.id,
    sender: input.sender,
    customer: null,
    source: "text",
    point: null,
    variantId: null,
    quantity: 1,
    note: input.text,
    confidence: 0.6,
    // A size with no position says WHAT but not WHICH, so a human picks the slot.
    state: "review",
    messageId: input.messageId,
  })
  await resolveSenders(input.post.id)
  return CAPTURE_REACTIONS.needsDetail
}

async function captureImageClaim(input: {
  sock: WASocket
  message: WAMessage
  post: WaPost
  sender: string
  messageId: string
  text: string
}): Promise<string> {
  const buffer = (await downloadMediaMessage(
    input.message,
    "buffer",
    {},
    { logger: quietLogger, reuploadRequest: input.sock.updateMediaMessage },
  )) as Buffer

  const dir = await mkdtemp(join(tmpdir(), "wa-reply-"))
  const scratch = join(dir, "reply.jpg")
  try {
    await writeFile(scratch, buffer)

    // Replies are normally discarded the moment their claim is recorded — the
    // group chat is the audit trail. Under WA_DEBUG one is kept, alongside what
    // the resolver made of it, because "it found one mark where I drew two" is
    // not answerable without the picture that produced it.
    if (process.env.WA_DEBUG) await keepForInspection(input, scratch)

    const { claimIds } = await ingestImageReply({
      postId: input.post.id,
      sender: input.sender,
      messageId: input.messageId,
      replyPath: scratch,
      caption: input.text,
    })
    await resolveSenders(input.post.id)
    await recluster(input.post.id)

    // The reply image itself is deliberately not kept — the spec discards them
    // once the claim is recorded, and the group chat is the audit trail.
    const claims = await listClaims(input.post.id)
    const mine = claims.filter((c) => claimIds.includes(c.id))

    if (mine.length === 0) return CAPTURE_REACTIONS.unreadable
    if (mine.some((c) => c.state === "review")) return CAPTURE_REACTIONS.needsDetail
    return CAPTURE_REACTIONS.recorded
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The post a reply is pointing at, or null when it quotes something else. */
export async function postForReply(groupJid: string, quoted: string): Promise<WaPost | null> {
  return findPostByMessage(groupJid, quoted)
}

/** Copy a reply and the resolver's verdict somewhere a human can look. */
async function keepForInspection(
  input: { post: WaPost; messageId: string },
  replyPath: string,
): Promise<void> {
  try {
    const dir = join(tmpdir(), "wa-debug")
    await mkdir(dir, { recursive: true })
    await copyFile(replyPath, join(dir, `${input.messageId}-reply.jpg`))

    const post = await getPost(input.post.id)
    if (post) {
      const { localPostImage } = await import("@/lib/whatsapp/post-image")
      await copyFile(await localPostImage(post.imagePath), join(dir, `${input.messageId}-post.jpg`))
    }

    const verdict = await resolveImageReply(
      (await localPostImagePath(input.post)) ?? "",
      replyPath,
    )
    console.log("[wa] resolver", {
      message: input.messageId,
      kind: verdict.kind,
      via: verdict.kind === "marks" ? verdict.via : undefined,
      marks: verdict.kind === "marks" ? verdict.marks.map((m) => ({
        x: Number(m.point.x.toFixed(3)),
        y: Number(m.point.y.toFixed(3)),
        pixels: m.pixels,
      })) : undefined,
      saved: dir,
    })
  } catch (err) {
    console.error("failed to save debug copies:", err)
  }
}

async function localPostImagePath(post: WaPost): Promise<string | null> {
  const { localPostImage } = await import("@/lib/whatsapp/post-image")
  return localPostImage(post.imagePath).catch(() => null)
}
