import type { WAMessage, WASocket } from "baileys"
import { startSession } from "./session"
import { parseCommand } from "./commands"
import { runCommand } from "./handle-command"
import { capturePost } from "./capture"
import { captureClaim, postForReply } from "./claims"
import { ReactionQueue } from "./reactions"
import { applyOwnerReaction, outcomeFor } from "./outcomes"
import { listClaims } from "@/lib/db/claims"
import { renderShoppingList } from "@/lib/whatsapp/render"
import sql from "@/lib/db-pool"

/**
 * One queue for the whole process, not one per message.
 *
 * The pacing only means anything if every reaction shares it — two queues
 * would happily fire at the same instant and produce exactly the volley the
 * pacing exists to avoid.
 */
let reactions: ReactionQueue | null = null

/** The text of a message, whatever kind it is. */
export function messageText(message: WAMessage): string {
  const content = message.message
  if (!content) return ""
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    ""
  )
}

/** The id of the message this one is replying to, or "". */
export function quotedId(message: WAMessage): string {
  const content = message.message
  return (
    content?.extendedTextMessage?.contextInfo?.stanzaId ??
    content?.imageMessage?.contextInfo?.stanzaId ??
    ""
  )
}

async function onMessage(sock: WASocket, message: WAMessage) {
  // Its own messages come back on this event. Reacting to them would loop.
  if (message.key.fromMe) return

  const groupJid = message.key.remoteJid ?? ""
  if (!groupJid.endsWith("@g.us")) return

  const sender = message.key.participant ?? ""
  const messageId = message.key.id ?? ""
  const text = messageText(message)

  const command = parseCommand(text)
  if (command) {
    const result = await runCommand({
      command,
      groupJid,
      groupName: (await sock.groupMetadata(groupJid).catch(() => null))?.subject ?? "",
      sender,
    })
    if (result.react) {
      await sock.sendMessage(groupJid, { react: { text: result.react, key: message.key } })
    }
    if (result.reply) await sock.sendMessage(groupJid, { text: result.reply })
    if (result.rekap) await sendRekap(sock, groupJid)
    return
  }

  const isImage = Boolean(message.message?.imageMessage)
  const quoted = quotedId(message)

  // An image that quotes nothing, from an admin, inside an open window, is a
  // new shelf. Everything else that quotes a post is somebody claiming.
  if (isImage && quoted === "") {
    await capturePost({ sock, message, groupJid, messageId, sender, caption: text })
    return
  }
  if (quoted === "") return

  const post = await postForReply(groupJid, quoted)
  if (post === null) return

  const emoji = await captureClaim({ sock, message, post, sender, messageId, text, isImage })
  if (emoji) reactions?.push({ jid: groupJid, key: message.key, emoji })
}

/**
 * Post the shopping list for this group's newest shelf.
 *
 * Newest rather than a chosen one: `/rekap` is typed one-handed in a shop, and
 * the shelf in front of the owner is the one they just posted. Older shelves are
 * a scroll away in the dashboard.
 */
async function sendRekap(sock: WASocket, groupJid: string) {
  const [post] = await sql`
    SELECT id FROM wa_posts WHERE group_jid = ${groupJid} ORDER BY id DESC LIMIT 1
  `
  if (!post) {
    await sock.sendMessage(groupJid, { text: "No shelf posted here yet." })
    return
  }
  const image = await renderShoppingList(post.id as number)
  await sock.sendMessage(groupJid, { image, caption: "" })
}

/**
 * Move every claim on a post to the reaction its outcome now deserves.
 *
 * Run after the owner's tick lands, because one tick can change one claim but a
 * short allocation changes several — the person who lost their unit needs their
 * cross without anybody composing a message.
 */
async function sweepOutcomes(groupJid: string, postId: number) {
  for (const claim of await listClaims(postId)) {
    const emoji = outcomeFor(claim)
    if (!emoji || !claim.messageId) continue
    reactions?.push({
      jid: groupJid,
      key: { remoteJid: groupJid, id: claim.messageId, fromMe: false },
      emoji,
    })
  }
}

async function main() {
  await startSession((sock) => {
    reactions = new ReactionQueue(async ({ jid, key, emoji }) => {
      await sock.sendMessage(jid, { react: { text: emoji, key } })
    })

    sock.ev.on("messages.reaction", async (events) => {
      for (const event of events) {
        try {
          const groupJid = event.key.remoteJid ?? ""
          if (!groupJid.endsWith("@g.us")) continue

          // reaction.key is the REACTOR's key; event.key is the message reacted
          // to. Skipping the bot's own stops it reading its own notes back.
          if (event.reaction.key?.fromMe) continue

          const applied = await applyOwnerReaction({
            reactorJid: event.reaction.key?.participant ?? "",
            messageId: event.key.id ?? "",
            emoji: event.reaction.text ?? "",
          })
          if (!applied) continue

          const [claim] = await sql`
            SELECT post_id FROM wa_claims WHERE message_id = ${event.key.id ?? ""} LIMIT 1
          `
          if (claim) await sweepOutcomes(groupJid, claim.post_id as number)
        } catch (err) {
          console.error("failed to handle a reaction:", err)
        }
      }
    })

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return
      for (const message of messages) {
        try {
          await onMessage(sock, message)
        } catch (err) {
          // One bad message must not take the socket down with it.
          console.error("failed to handle a message:", err)
        }
      }
    })
  })
}

main().catch((err) => {
  console.error("worker failed to start:", err)
  process.exit(1)
})
