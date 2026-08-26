import { test } from "node:test"
import assert from "node:assert/strict"
import { causeLineFor, fillNotice, REFUND_CAUSES } from "./notice-templates"
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS, findMissingTokens, fillTemplate } from "./message-templates"

const EVENT = "LSJP202605"
const ITEMS = "Anello Backpack Regular Navy × 1"
const RECEIVED = "Muji Shoulder Bag 9L Beige"

function whatsapp(reasonKey: string, have: { items?: string; receivedItem?: string }) {
  const cause = REFUND_CAUSES.find((c) => c.key === reasonKey)!
  const line = fillNotice(causeLineFor(cause, have, "whatsapp"), {
    "{event}": EVENT, "{itemsList}": have.items ?? "", "{receivedItem}": have.receivedItem ?? "",
  })
  return fillTemplate(DEFAULT_TEMPLATES.refund_specific, {
    customer: "someone", event: EVENT, itemsList: have.items ?? "",
    receivedItem: have.receivedItem ?? "", cause: line, refundAmount: "Rp 560.000",
  })
}

test("every template still carries the tokens it is required to", () => {
  for (const key of TEMPLATE_KEYS) {
    assert.deepEqual(findMissingTokens(DEFAULT_TEMPLATES[key], key), [], key)
  }
})

test("every refund reason has its own WhatsApp wording", () => {
  // The whole point: before this, each of them said "tidak tersedia", so a
  // damaged parcel and a lost one reached the customer as an item being out of
  // stock. Distinct wording is what stops that coming back.
  const lines = REFUND_CAUSES.map((c) =>
    fillNotice(causeLineFor(c, { items: ITEMS, receivedItem: RECEIVED }, "whatsapp"), {
      "{event}": EVENT, "{itemsList}": ITEMS, "{receivedItem}": RECEIVED,
    }))
  assert.equal(new Set(lines).size, REFUND_CAUSES.length, "two reasons share a sentence")
  for (const line of lines) assert.ok(line.trim().length > 0, "a reason says nothing")
})

test("a WhatsApp refund still asks for the bank details", () => {
  // The one thing this message exists to do. The inbox card has buttons for it;
  // WhatsApp has to ask in writing.
  for (const key of ["unavailable", "damaged", "wrong_item", "shipping_loss", "overpayment", "goodwill", "other"]) {
    const msg = whatsapp(key, { items: ITEMS, receivedItem: RECEIVED })
    assert.match(msg, /Nama Bank:/, key)
    assert.match(msg, /Nomor Rekening:/, key)
    assert.match(msg, /Nama Pemilik Rekening:/, key)
    assert.match(msg, new RegExp(EVENT), `${key} does not name the trip`)
    assert.match(msg, /Rp 560\.000/, `${key} does not name the amount`)
  }
})

test("a wrong delivery names what came and offers to let them keep it", () => {
  const msg = whatsapp("wrong_item", { items: ITEMS, receivedItem: RECEIVED })
  assert.match(msg, new RegExp(RECEIVED))
  assert.match(msg, /tetap mengambil barang yang datang/)
})

test("nothing recorded means no hole in the sentence", () => {
  // fillTemplate leaves an unknown token as written, so a missing value would
  // reach the customer as "{receivedItem}" in the middle of a sentence.
  const msg = whatsapp("wrong_item", { items: ITEMS })
  assert.doesNotMatch(msg, /\{receivedItem\}/)
  assert.doesNotMatch(msg, /\{\w+\}/, "an unfilled placeholder survived")
})

test("the trip is named once, not twice", () => {
  const msg = whatsapp("unavailable", { items: ITEMS })
  assert.equal(msg.split(EVENT).length - 1, 1)
})
