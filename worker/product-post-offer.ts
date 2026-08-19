import type { WASocket } from "baileys"
import { getSend, getSendCodeByCode } from "@/lib/db/wa-sends"
import { parseCodes } from "@/lib/whatsapp/codes"
import { createAskingRequest, resolveAskingCandidate, findRequestByBotMessage } from "@/lib/db/catalogue-requests"
import type { ProductPostResolution } from "./product-post"

/**
 * Post the ❔ question and write the asking row, in that order — the row
 * needs the sent message's id (bot_message_id) to be answerable later, so
 * the send must happen first.
 */
export async function askDisambiguation(
  sock: WASocket,
  input: { groupJid: string; messageId: string; sender: string; text: string; quoted: string },
  resolution: Extract<ProductPostResolution, { kind: "needsDisambiguation" }>,
): Promise<string> {
  const question =
    resolution.candidates.length === 1
      ? `Maksudnya ${resolution.candidates[0].code} ${resolution.candidates[0].productName} — Rp ${resolution.candidates[0].price.toLocaleString("id-ID")} ya kak? 👍 kalau betul`
      : resolution.candidates.length > 1
        ? `Yang mana kak?\n${resolution.candidates.map((c) => `${c.code} ${c.productName}`).join(" · ")}\nBalas kodenya ya 🙏`
        : "Kodenya yang mana kak? 🙏"

  const sent = await sock.sendMessage(
    input.groupJid,
    { text: question },
    { quoted: { key: { remoteJid: input.groupJid, id: input.messageId, fromMe: false }, message: {} } },
  )
  const botMessageId = sent?.key?.id ?? ""

  await createAskingRequest({
    customerHandle: resolution.customerHandle,
    qty: resolution.qty,
    note: input.text,
    sendId: resolution.send.id,
    sender: input.sender,
    messageId: input.messageId,
    botMessageId,
    candidateSendCodeIds: resolution.candidates.map((c) => c.id),
  })

  return "❔"
}

/**
 * Settle an open asking row from the customer side — either a 👍 landing on
 * the bot's confirmation question (single candidate), or a text reply
 * naming one of the offered codes (multiple candidates). Checked before the
 * generic claim path in worker/index.ts, mirroring how trySizeOffer/
 * trySizeAnswer are checked ahead of the shelf claim path today.
 */
export async function trySendOfferAnswer(input: {
  groupJid: string; messageId: string; sender: string; text: string; quoted: string
}): Promise<string | null> {
  if (!input.quoted) return null
  const request = await findRequestByBotMessage(input.quoted)
  if (request === null) return null

  const codes = parseCodes(input.text)
  if (codes.length !== 1) return null

  const candidateIds = request.candidateSendCodeIds ?? []
  if (candidateIds.length === 0) return null

  // Resolve the typed code to a wa_send_codes row via the request's own
  // send (for its event), then confirm it is one of the codes actually
  // offered — a code she types that wasn't among the options must not
  // silently resolve here.
  const send = await getSend(request.sendId!)
  if (send === null) return null
  const sendCode = await getSendCodeByCode(send.event, codes[0])
  if (sendCode === null || !candidateIds.includes(sendCode.id)) return null

  await resolveAskingCandidate(request.id, sendCode.id, "customer")
  return "📝"
}

/** A 👍 landing on the bot's own single-candidate question. */
export async function trySendOfferThumbsUp(groupJid: string, quotedMessageId: string): Promise<string | null> {
  const request = await findRequestByBotMessage(quotedMessageId)
  if (request === null) return null
  const candidateIds = request.candidateSendCodeIds ?? []
  if (candidateIds.length !== 1) return null // multi-candidate offers are never settled by a bare 👍

  await resolveAskingCandidate(request.id, candidateIds[0], "customer")
  return "✅"
}
