import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeDelivery, waLink, DEFAULT_MESSAGE_DELIVERY } from "./message-delivery"

test("an unset column reads as copy, which is what every screen did before", () => {
  assert.deepEqual(normalizeDelivery({}), DEFAULT_MESSAGE_DELIVERY)
  assert.deepEqual(normalizeDelivery(null), DEFAULT_MESSAGE_DELIVERY)
  assert.deepEqual(normalizeDelivery("nonsense"), DEFAULT_MESSAGE_DELIVERY)
})

test("a stored choice is kept, kind by kind", () => {
  assert.deepEqual(
    normalizeDelivery({ refund: "whatsapp" }),
    { invoice: "copy", refund: "whatsapp", shipment: "copy" },
  )
})

test("a value nobody recognises falls back to copy, not to opening a chat", () => {
  // Copying puts text on the clipboard and waits. An unexpected "whatsapp"
  // opens a window with a message in it, which is a worse thing to guess.
  assert.equal(normalizeDelivery({ refund: "telegram" }).refund, "copy")
  assert.equal(normalizeDelivery({ refund: 7 }).refund, "copy")
})

test("a doubly-encoded column still answers", () => {
  // `${JSON.stringify(x)}::jsonb` stores the TEXT of the settings, not the
  // settings. It read back as a plain string and every kind quietly defaulted
  // to copy -- a setting that saves, reloads looking saved, and does nothing.
  assert.deepEqual(
    normalizeDelivery('{"invoice":"whatsapp","refund":"whatsapp","shipment":"copy"}'),
    { invoice: "whatsapp", refund: "whatsapp", shipment: "copy" },
  )
  assert.deepEqual(normalizeDelivery("not json at all"), DEFAULT_MESSAGE_DELIVERY)
})

test("keys nobody asked about are dropped", () => {
  assert.deepEqual(normalizeDelivery({ invoice: "whatsapp", pigeon: "whatsapp" }), {
    invoice: "whatsapp", refund: "copy", shipment: "copy",
  })
})

test("her number reaches WhatsApp in the form it wants", () => {
  // Stored however it was typed; WhatsApp wants digits, international.
  for (const typed of ["08123456789", "8123456789", "+62 812-3456-789", "62 812 3456 789"]) {
    const link = waLink(typed, "hi")
    assert.match(link, /^https:\/\/wa\.me\/62/, typed)
  }
})

test("no number opens the chooser rather than refusing", () => {
  // This is the case the refund screen was stuck in for every customer: its
  // link carried no number at all, so it always asked you to find her.
  const link = waLink("", "Halo")
  assert.equal(link, "https://api.whatsapp.com/send?text=Halo")
})

test("the message survives the trip", () => {
  const link = waLink("08123456789", "Rp 100.000 & terima kasih")
  assert.ok(link.includes(encodeURIComponent("Rp 100.000 & terima kasih")))
})
