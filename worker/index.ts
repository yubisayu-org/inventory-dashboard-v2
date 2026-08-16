import type { WAMessage, WASocket } from "baileys"
import { startSession } from "./session"
import { parseCommand } from "./commands"
import { runCommand } from "./handle-command"
import { capturePost } from "./capture"
import { captureClaim, postForReply } from "./claims"
import { ReactionQueue } from "./reactions"
import { applyOwnerReaction, outcomeFor } from "./outcomes"
import { findPostByMessage, listClaims } from "@/lib/db/claims"
import { renderShoppingList } from "@/lib/whatsapp/render"
import sql from "@/lib/db-pool"
import { isBotAdmin } from "@/lib/db/whatsapp-groups"
import { senderJid, senderNumber } from "./handle-command"

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

/**
 * Opt-in tracing for "the bot did nothing and I cannot tell why".
 *
 * Every rejection in this worker is silent by design — an unknown sender, a
 * closed window, an unrecognised word — which makes a real fault look exactly
 * like correct behaviour. This prints the few fields that distinguish them.
 *
 * Off unless WA_DEBUG is set, and it never prints message text: knowing the
 * shape of a sender's JID is a debugging need, reading the group's chat is not.
 */
const DEBUG = Boolean(process.env.WA_DEBUG)

/**
 * How old a message may be and still be acted on, in seconds.
 *
 * Messages arrive as "notify" when the socket is healthy and "append" when it is
 * catching up — after a reconnect, or when the phone hands over a backlog. Both
 * carry real claims, so both are processed; ignoring "append" meant a flaky
 * connection silently swallowed everything, which is how this was found.
 *
 * The age check is what makes that safe. A history replay would otherwise
 * re-ingest weeks of shelves and claims. An hour is long enough to recover a
 * worker restart mid-trip and short enough that no genuine backlog is lost.
 */
const MAX_MESSAGE_AGE_SECONDS = 3600

/** Seconds since a message was sent, or 0 when it carries no timestamp. */
function messageAge(message: WAMessage): number {
  const raw = message.messageTimestamp
  const seconds = typeof raw === "number" ? raw : Number(raw?.toString() ?? 0)
  if (!seconds) return 0
  return Math.floor(Date.now() / 1000) - seconds
}

async function trace(sock: WASocket, message: WAMessage) {
  if (!DEBUG) return
  const jid = senderJid(message.key)
  const text = messageText(message)
  const number = senderNumber(jid)
  console.log("[wa]", {
    // fromMe true on a message YOU sent means the linked device is your own
    // number rather than the bot's — the worker drops those to avoid reacting
    // to itself, so nothing else would ever print.
    fromMe: message.key.fromMe,
    linkedAs: sock.user?.id ?? "(unknown)",
    chat: message.key.remoteJid,
    // What the code actually uses, after preferring a number-bearing JID over
    // a privacy id.
    resolvedJid: jid || "(none)",
    rawParticipant: message.key.participant ?? "(none)",
    parsedNumber: number || "(empty)",
    isAdmin: number ? await isBotAdmin(number) : false,
    isCommand: Boolean(parseCommand(text)),
    kind: Object.keys(message.message ?? {})[0] ?? "(empty)",
    // Empty on a reply means the quote is not where quotedId() looks for it,
    // which sends the message down the "fresh image" branch and drops it.
    quoted: quotedId(message) || "(none)",
    contextKeys: Object.keys(
      (message.message?.imageMessage?.contextInfo ??
        message.message?.extendedTextMessage?.contextInfo ??
        {}) as object,
    ),
  })
}

async function onMessage(sock: WASocket, message: WAMessage) {
  // Its own messages come back on this event. Reacting to them would loop.
  if (message.key.fromMe) return

  const groupJid = message.key.remoteJid ?? ""
  if (!groupJid.endsWith("@g.us")) return

  const sender = senderJid(message.key)
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
    if (result.rekap) await sendRekap(sock, groupJid, quotedId(message))
    return
  }

  const isImage = Boolean(message.message?.imageMessage)
  const quoted = quotedId(message)

  // An image that quotes nothing, from an admin, inside an open window, is a
  // new shelf. Everything else that quotes a post is somebody claiming.
  if (isImage && quoted === "") {
    const postId = await capturePost({ sock, message, groupJid, messageId, sender, caption: text })
    // Acknowledge a captured shelf. Without this the owner cannot tell a photo
    // that became a post from one the closed window ignored — and a customer
    // replying to the second gets silence, which is how an afternoon goes
    // missing.
    if (postId !== null) reactions?.push({ jid: groupJid, key: message.key, emoji: "📸" })
    return
  }
  if (quoted === "") return

  const post = await postForReply(groupJid, quoted)
  if (post === null) return

  const emoji = await captureClaim({ sock, message, post, sender, messageId, text, isImage })
  if (emoji) reactions?.push({ jid: groupJid, key: message.key, emoji })
}

/**
 * Post the shopping list for a shelf.
 *
 * Send /rekap as a reply to a shelf photo and that is the shelf rendered;
 * otherwise it falls back to the newest in the group, which is usually the one
 * the owner just posted.
 *
 * The reply form exists because "newest" is only right when nothing else has
 * been posted since — and by the time a trip is under way, several shelves are
 * in the chat and the interesting one is rarely the last.
 */
async function sendRekap(sock: WASocket, groupJid: string, quoted: string) {
  // Pointing at something and silently getting something else is worse than an
  // error. If the reply quotes a message that is not a shelf we captured — a
  // photo sent while the window was closed, a customer's claim, the bot's own
  // last rekap — say so rather than falling back to the newest and looking like
  // the wrong shelf was rendered.
  if (quoted) {
    const quotedPost = await findPostByMessage(groupJid, quoted)
    if (DEBUG) console.log("[wa] rekap", { quoted, resolved: quotedPost?.id ?? null })
    if (!quotedPost) {
      await sock.sendMessage(groupJid, {
        text: "That message is not a shelf I captured — reply to the photo that got a 📸.",
      })
      return
    }
    await sock.sendMessage(groupJid, { image: await renderShoppingList(quotedPost.id), caption: "" })
    return
  }

  const [post] = await sql`
    SELECT id FROM wa_posts WHERE group_jid = ${groupJid} ORDER BY id DESC LIMIT 1
  `
  if (DEBUG) console.log("[wa] rekap", { quoted: "(none)", resolved: post?.id ?? null })
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
            reactorJid: senderJid(event.reaction.key),
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
      if (DEBUG) console.log("[wa] upsert", { type, count: messages.length })
      for (const message of messages) {
        try {
          const age = messageAge(message)
          if (age > MAX_MESSAGE_AGE_SECONDS) {
            if (DEBUG) console.log("[wa] skipped, too old", { age })
            continue
          }
          await trace(sock, message)
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
