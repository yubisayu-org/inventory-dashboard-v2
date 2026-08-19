import { test } from "node:test"
import assert from "node:assert/strict"
import type { WAMessage } from "baileys"
import { imageDocument, messageText, quotedId } from "./message"

/** A message carrying just the content under test. */
const msg = (message: unknown) => ({ key: {}, message } as WAMessage)

test("a photo attached as a file is a photo", () => {
  const bare = msg({ documentMessage: { mimetype: "image/jpeg", fileName: "shelf.jpg" } })
  assert.ok(imageDocument(bare))

  // WhatsApp wraps the document once a caption is typed, which is the form the
  // owner's sends take: the store name rides along as the caption.
  const captioned = msg({
    documentWithCaptionMessage: {
      message: { documentMessage: { mimetype: "image/png", caption: "rak 2" } },
    },
  })
  assert.ok(imageDocument(captioned))
  assert.equal(messageText(captioned), "rak 2")
})

test("a file that is not an image is not a shelf", () => {
  assert.equal(imageDocument(msg({ documentMessage: { mimetype: "application/pdf" } })), null)
  assert.equal(imageDocument(msg({ documentMessage: {} })), null, "no mimetype is not an image")
  assert.equal(imageDocument(msg({ conversation: "halo" })), null)
})

test("a document reply quotes what it replied to", () => {
  assert.equal(
    quotedId(msg({ documentMessage: { mimetype: "image/jpeg", contextInfo: { stanzaId: "abc" } } })),
    "abc",
  )
  assert.equal(
    quotedId(msg({
      documentWithCaptionMessage: {
        message: { documentMessage: { mimetype: "image/jpeg", contextInfo: { stanzaId: "def" } } },
      },
    })),
    "def",
  )
  assert.equal(quotedId(msg({ conversation: "halo" })), "", "an ordinary message quotes nothing")
})
