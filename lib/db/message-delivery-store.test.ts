import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getBusinessProfile, updateBusinessProfile } from "./settings"
import type { BusinessProfile } from "../business-profile"

let original: BusinessProfile

before(async () => { original = await getBusinessProfile() })
after(async () => {
  await updateBusinessProfile(original)
  await sql.end()
})

test("the choice survives a round trip", async () => {
  await updateBusinessProfile({
    ...original,
    messageDelivery: { invoice: "copy", refund: "whatsapp", shipment: "whatsapp" },
  })
  const read = await getBusinessProfile()
  assert.deepEqual(read.messageDelivery, {
    invoice: "copy", refund: "whatsapp", shipment: "whatsapp",
  })
})

test("a row that predates the column reads as copy", async () => {
  // Every existing install has '{}' here, and every screen copied before this
  // setting existed. Nobody's button should change behaviour on deploy.
  await sql`UPDATE business_profile SET message_delivery = '{}'::jsonb WHERE id = 1`
  const read = await getBusinessProfile()
  assert.deepEqual(read.messageDelivery, {
    invoice: "copy", refund: "copy", shipment: "copy",
  })
})

test("nonsense in the column does not reach a screen", async () => {
  await sql`UPDATE business_profile SET message_delivery = ${'{"refund":"carrier pigeon","x":1}'}::jsonb WHERE id = 1`
  const read = await getBusinessProfile()
  assert.equal(read.messageDelivery.refund, "copy")
})
