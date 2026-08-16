import type { WAMessage, WASocket } from "baileys"
import { startSession } from "./session"
import { parseCommand } from "./commands"
import { runCommand } from "./handle-command"
import { capturePost } from "./capture"
import { captureClaim, postForReply } from "./claims"
import { ReactionQueue } from "./reactions"

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
    // Rendering and sending the shopping list arrives in task 6.
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

async function main() {
  await startSession((sock) => {
    reactions = new ReactionQueue(async ({ jid, key, emoji }) => {
      await sock.sendMessage(jid, { react: { text: emoji, key } })
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
