import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { updateTrackingNumber } from "./fulfillment"

const TAG = `resinotice${process.hrtime.bigint()}`
const EV1 = `${TAG}_EV1`
const EV2 = `${TAG}_EV2`
const WHO = `${TAG}_c`

async function shipment(event: string, resi = "", mergeGroup: string | null = null) {
  const [s] = await sql<{ id: number }[]>`
    INSERT INTO shipments (event, customer, shipping_id, invoicing, tracking_number, merge_group)
    VALUES (${event}, ${WHO}, ${`${TAG}-${event}-${Math.random().toString(36).slice(2, 8)}`},
            '', ${resi}, ${mergeGroup})
    RETURNING id`
  return s.id
}

async function notices() {
  return await sql<{ title: string; body: string }[]>`
    SELECT an.title, an.body FROM announcements an
      JOIN customers c ON c.id = an.customer_id
     WHERE c.instagram_id = ${WHO} ORDER BY an.id`
}

before(async () => {
  for (const e of [EV1, EV2]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id = ${WHO})`
  await sql`DELETE FROM shipments WHERE customer = ${WHO}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id = ${WHO}`
  await sql.end()
})

test("filling the resi tells her, because shipping deliberately could not", async () => {
  // The parcel notice says a number will appear later -- whether a resi is
  // ready to be seen is the shop's call. This is that call being made.
  const id = await shipment(EV1)
  await updateTrackingNumber(id, "JP1234567890")

  const sent = await notices()
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, new RegExp(EV1))
  assert.match(sent[0].body, /JP1234567890/)
})

test("saving the same number again says nothing", async () => {
  // A form that was opened and closed is not news.
  const before = (await notices()).length
  const [row] = await sql<{ id: number }[]>`
    SELECT id FROM shipments WHERE customer = ${WHO} AND event = ${EV1} LIMIT 1`
  await updateTrackingNumber(row.id, "JP1234567890")
  assert.equal((await notices()).length, before)
})

test("a corrected number says the old one no longer applies", async () => {
  // She may be watching the wrong number, which is worse than watching none.
  const [row] = await sql<{ id: number }[]>`
    SELECT id FROM shipments WHERE customer = ${WHO} AND event = ${EV1} LIMIT 1`
  await updateTrackingNumber(row.id, "JP9999999999")

  const sent = await notices()
  const last = sent[sent.length - 1]
  assert.match(last.title, /changed/)
  assert.match(last.body, /JP9999999999/)
  assert.match(last.body, /JP1234567890/, "and names the one she was following")
})

test("clearing it says nothing", async () => {
  // An emptied field is a correction in progress, not something she can act on.
  const before = (await notices()).length
  const [row] = await sql<{ id: number }[]>`
    SELECT id FROM shipments WHERE customer = ${WHO} AND event = ${EV1} LIMIT 1`
  await updateTrackingNumber(row.id, "")
  assert.equal((await notices()).length, before)
})

test("one box, one notice, however many rows it is", async () => {
  // A merged shipment is several rows and one physical parcel. Three notices
  // about one box is the shop talking to itself.
  const group = `${TAG}-merge`
  const a = await shipment(EV1, "", group)
  await shipment(EV2, "", group)
  const before = (await notices()).length

  await updateTrackingNumber(a, "JPMERGED001")

  const sent = await notices()
  assert.equal(sent.length, before + 1, "one notice")
  const last = sent[sent.length - 1]
  assert.match(last.title, new RegExp(EV1))
  assert.match(last.title, new RegExp(EV2), "naming both trips in the box")

  const rows = await sql<{ tracking_number: string }[]>`
    SELECT tracking_number FROM shipments WHERE merge_group = ${group}`
  assert.ok(rows.every((r) => r.tracking_number === "JPMERGED001"), "and both rows carry it")
})
