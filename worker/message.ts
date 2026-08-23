import type { WAMessage } from "baileys"

// Kept apart from index.ts, which starts a WhatsApp session the moment it is
// imported. These are pure readers of a message and are worth testing.

/** The text of a message, whatever kind it is. */
export function messageText(message: WAMessage): string {
  const content = message.message
  if (!content) return ""
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.documentMessage?.caption ??
    content.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    content.videoMessage?.caption ??
    ""
  )
}

/**
 * A photograph sent as a file rather than a photo.
 *
 * WhatsApp compresses every photo it carries — a shelf arrives about 1200
 * pixels across, which leaves a price tag a few dozen pixels tall. A document
 * is passed through untouched, so this is the only way a legible tag reaches
 * the dashboard. Attaching one wraps it in documentWithCaptionMessage when a
 * caption is typed, and leaves it bare when it is not.
 *
 * Only images: a PDF price list is a file somebody shared, not a shelf.
 */
export function imageDocument(message: WAMessage) {
  const content = message.message
  const doc =
    content?.documentMessage ??
    content?.documentWithCaptionMessage?.message?.documentMessage ??
    null
  if (!doc) return null
  return (doc.mimetype ?? "").startsWith("image/") ? doc : null
}

/** The id of the message this one is replying to, or "". */
export function quotedId(message: WAMessage): string {
  const content = message.message
  return (
    content?.extendedTextMessage?.contextInfo?.stanzaId ??
    content?.imageMessage?.contextInfo?.stanzaId ??
    content?.documentMessage?.contextInfo?.stanzaId ??
    content?.documentWithCaptionMessage?.message?.documentMessage?.contextInfo?.stanzaId ??
    ""
  )
}
