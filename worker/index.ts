import type { WAMessage, WASocket } from "baileys"
import { startSession } from "./session"
import { parseCommand } from "./commands"
import { runCommand } from "./handle-command"
import { capturePost } from "./capture"
import { captureClaim, postForReply } from "./claims"
import { matchPostByImage } from "@/lib/whatsapp/ingest"
import {
  answerAsk, findCustomerByNumber, hasBeenAsked, parseHandle, pendingAsk, recordAsk,
} from "@/lib/whatsapp/identity"
import { ReactionQueue } from "./reactions"
import { applyOwnerReaction, outcomeFor } from "./outcomes"
import { trySizeOffer, trySizeAnswer } from "./size-offer"
import { sendNextShelf, OUTBOX_INTERVAL_MS } from "./outbox"
import { findPostByMessage, listClaims } from "@/lib/db/claims"
import { renderShoppingList } from "@/lib/whatsapp/render"
import sql from "@/lib/db-pool"
import { isBotAdmin } from "@/lib/db/whatsapp-groups"
import { senderJid, senderNumber } from "./handle-command"
import { messageText, quotedId, imageDocument } from "./message"

/**
 * One queue for the whole process, not one per message.
 *
 * The pacing only means anything if every reaction shares it — two queues
 * would happily fire at the same instant and produce exactly the volley the
 * pacing exists to avoid.
 */
let reactions: ReactionQueue | null = null

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
    // What an image message actually carries. Ticking HD sends a copy that is
    // SMALLER than a plain send, so the question is whether a better one is
    // referenced here and merely not downloaded — every field name is printed
    // rather than a chosen few, because the field that answers it is the one
    // nobody thought to look for.
    imageFields: message.message?.imageMessage
      ? {
          size: `${message.message.imageMessage.width}x${message.message.imageMessage.height}`,
          bytes: Number(message.message.imageMessage.fileLength ?? 0),
          keys: Object.keys(message.message.imageMessage).filter(
            (k) => (message.message?.imageMessage as Record<string, unknown>)[k] != null,
          ),
        }
      : undefined,
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

  // An answer to "who are you" is consumed here so it is never also read as a
  // claim or a command.
  if (text && (await tryIdentityAnswer(sock, groupJid, message, sender, text))) return

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

  // A photo sent as a file counts as a photo — see imageDocument. Everything
  // downstream takes bytes, and Baileys downloads both the same way.
  const isImage = Boolean(message.message?.imageMessage) || imageDocument(message) !== null
  const quoted = quotedId(message)

  // An image that quotes nothing, from an admin, inside an open window, is a
  // new shelf. Everything else that quotes a post is somebody claiming.
  if (isImage && quoted === "") {
    const postId = await capturePost({ sock, message, groupJid, messageId, sender, caption: text })
    // Acknowledge a captured shelf. Without this the owner cannot tell a photo
    // that became a post from one the closed window ignored — and a customer
    // replying to the second gets silence, which is how an afternoon goes
    // missing.
    if (postId !== null) {
      reactions?.push({ jid: groupJid, key: message.key, emoji: "📸" })
      return
    }
    // Not a shelf. Then it is somebody marking one without using Reply, which
    // customers do constantly — replying is a habit, not a reflex. Work out
    // which shelf by subtracting it from each recent one: the shelf that yields
    // pen strokes is the shelf they marked.
    await claimWithoutReply(sock, message, groupJid, messageId, sender, text)
    return
  }
  if (quoted === "") return

  // The owner answering a claim with a different size — "95 kosong, 100 ya".
  // Checked before the claim path because it quotes a claim, not a shelf, and
  // would otherwise fall straight through postForReply and be dropped.
  const offered = await trySizeOffer({ groupJid, messageId, sender, text, quoted })
  if (offered) {
    reactions?.push({ jid: groupJid, key: message.key, emoji: offered })
    return
  }

  const post = await postForReply(groupJid, quoted)
  if (post === null) return

  const emoji = await captureClaim({ sock, message, post, sender, messageId, text, isImage })
  if (emoji) reactions?.push({ jid: groupJid, key: message.key, emoji })
  await askWhoTheyAre(sock, groupJid, message, sender)
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
/**
 * Record a marked photo that never quoted the shelf it belongs to.
 *
 * Silence was the old behaviour and the worst possible one: no claim, no
 * reaction, and a customer sure they had ordered. Anything that cannot be
 * matched now earns 😢, which asks them to try again rather than leaving them
 * to find out at delivery.
 */
/** What the bot says, once, to a number it cannot place. */
const IDENTITY_QUESTION =
  "Halo, Mak! Apakah sudah isi data pengiriman di form registrasi? Kalau belum, boleh isi dulu " +
  "ya. Kalau sudah isi, boleh info username-nya? Biar orderannya bisa direkap, terima kasih."

/**
 * Ask an unrecognised claimant who they are — once, ever.
 *
 * This is the only thing the bot says without being spoken to first, so it is
 * fenced accordingly: only after they have actually claimed something, only if
 * their number is on no customer record, and never a second time. Asking again
 * on every shelf they claim would pester the customer and give the number the
 * one activity pattern worth avoiding.
 *
 * Sent as a reply to their own claim, so their answer quotes it and comes back
 * identifiable.
 */
async function askWhoTheyAre(sock: WASocket, groupJid: string, message: WAMessage, sender: string) {
  const number = senderNumber(sender)
  if (!number) return
  if (await findCustomerByNumber(number)) return
  if (await hasBeenAsked(number)) return

  const sent = await sock.sendMessage(groupJid, { text: IDENTITY_QUESTION }, { quoted: message })
  await recordAsk(number, sent?.key?.id ?? "")
}

/**
 * Take an answer to that question, if this message is one.
 *
 * Only from a number with a question outstanding, and only when the whole
 * message is a plausible handle — this runs against ordinary group chatter, and
 * reading "iya kak" as a username would attach someone's orders to a stranger.
 *
 * Returns true when the message was consumed as an answer, so it is not also
 * read as a claim.
 */
async function tryIdentityAnswer(
  sock: WASocket,
  groupJid: string,
  message: WAMessage,
  sender: string,
  text: string,
): Promise<boolean> {
  const number = senderNumber(sender)
  if (!number) return false

  const ask = await pendingAsk(number)
  if (ask === null) return false

  const handle = parseHandle(text)
  if (handle === null) return false

  if (await answerAsk(number, handle)) {
    reactions?.push({ jid: groupJid, key: message.key, emoji: "📝" })
    return true
  }

  // A handle nobody has. Said plainly rather than silently ignored, because the
  // customer has answered and deserves to know it did not land.
  await sock.sendMessage(
    groupJid,
    { text: `Belum ketemu akun "${handle}" kak. Coba cek lagi ya 🙏` },
    { quoted: message },
  )
  return true
}

async function claimWithoutReply(
  sock: WASocket,
  message: WAMessage,
  groupJid: string,
  messageId: string,
  sender: string,
  text: string,
) {
  const { downloadMediaMessage } = await import("baileys")
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { quietLogger } = await import("./logger")

  const buffer = (await downloadMediaMessage(
    message,
    "buffer",
    {},
    { logger: quietLogger, reuploadRequest: sock.updateMediaMessage },
  )) as Buffer

  const dir = await mkdtemp(join(tmpdir(), "wa-unquoted-"))
  const scratch = join(dir, "reply.jpg")
  try {
    await writeFile(scratch, buffer)
    const match = await matchPostByImage(groupJid, scratch)
    if (match === null) {
      // Keep the picture that failed to match. "I sent the right photo" is not
      // arguable without it.
      if (process.env.WA_DEBUG) {
        const { copyFile, mkdir } = await import("node:fs/promises")
        const debugDir = join(tmpdir(), "wa-debug")
        await mkdir(debugDir, { recursive: true })
        await copyFile(scratch, join(debugDir, `${messageId}-unmatched.jpg`))
        console.log("[wa] unmatched image saved", { messageId, dir: debugDir })
      }
      reactions?.push({ jid: groupJid, key: message.key, emoji: "😢" })
      return
    }

    // captureClaim re-runs the resolver, which for an untouched frame lands on
    // "repost" and files it for review — the same outcome a reply to that
    // photograph would have had.
    const emoji = await captureClaim({
      sock, message, post: match.post, sender, messageId, text, isImage: true,
    })
    if (emoji) reactions?.push({ jid: groupJid, key: message.key, emoji })
    await askWhoTheyAre(sock, groupJid, message, sender)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

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

  // Newest shelf that anyone has actually claimed on, not simply the newest.
  // A shopping list for a shelf with no claims is a picture of nothing to buy,
  // and posting several shelves in a row — which is the normal way to work a
  // shop — otherwise buries the one being discussed.
  const [post] = await sql`
    SELECT p.id FROM wa_posts p
    WHERE p.group_jid = ${groupJid}
      AND EXISTS (
        SELECT 1 FROM wa_claims c
        WHERE c.post_id = p.id AND c.state <> 'rejected'
      )
    ORDER BY p.id DESC LIMIT 1
  `
  if (DEBUG) console.log("[wa] rekap", { quoted: "(none)", resolved: post?.id ?? null })
  if (!post) {
    await sock.sendMessage(groupJid, {
      text: "Nothing claimed yet. Reply /rekap to a shelf to see it anyway.",
    })
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

    // Shelves uploaded in the dashboard, waiting to be posted. A queue rather
    // than a call because the dashboard has no socket — and because a shelf
    // uploaded while this process is down should go out when it returns rather
    // than be lost.
    const outbox = setInterval(async () => {
      try {
        while (await sendNextShelf(sock)) {
          // Keep going while the queue has work: an upload of forty racks
          // should not take three and a half minutes to appear.
          await new Promise((resolve) => setTimeout(resolve, 1200))
        }
      } catch (err) {
        console.error("outbox sweep failed:", err)
      }
    }, OUTBOX_INTERVAL_MS)
    sock.ev.on("connection.update", ({ connection }) => {
      if (connection === "close") clearInterval(outbox)
    })

    sock.ev.on("messages.reaction", async (events) => {
      for (const event of events) {
        try {
          const groupJid = event.key.remoteJid ?? ""
          if (!groupJid.endsWith("@g.us")) continue

          // reaction.key is the REACTOR's key; event.key is the message reacted
          // to. Skipping the bot's own stops it reading its own notes back.
          if (event.reaction.key?.fromMe) continue

          // Her 👍 on an offer of a different size. Tried first: the same emoji
          // means "bought" when the owner puts it on a claim, and these are told
          // apart by what was reacted to, not by the emoji.
          const answered = await trySizeAnswer({
            groupJid,
            messageId: event.key.id ?? "",
            reactorJid: senderJid(event.reaction.key),
            emoji: event.reaction.text ?? "",
          })
          if (answered) {
            reactions?.push({ jid: groupJid, key: event.key, emoji: answered })
            continue
          }

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

          // And it must not look like nothing happened. Every rejection in this
          // worker is silent by design, so a genuine fault — an image format
          // sharp cannot read, a bucket that refused the upload — is
          // indistinguishable from "not for me" to the person who sent it. 😢
          // is the same thing an unmatched photo already gets: it arrived, it
          // did not land, send it again.
          const groupJid = message.key.remoteJid ?? ""
          if (!message.key.fromMe && groupJid.endsWith("@g.us")) {
            reactions?.push({ jid: groupJid, key: message.key, emoji: "😢" })
          }
        }
      }
    })
  })
}

main().catch((err) => {
  console.error("worker failed to start:", err)
  process.exit(1)
})
