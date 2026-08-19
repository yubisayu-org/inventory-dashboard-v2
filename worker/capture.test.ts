import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import type { WAMessage, WASocket } from "baileys"
import sql from "../lib/db-pool"
import {
  addBotAdmin, bindGroupToEvent, closeCapture, openCapture, upsertGroup,
} from "../lib/db/whatsapp-groups"
import { capturePost } from "./capture"

const EVENT = `TESTCAP${process.hrtime.bigint()}`
const JID = `${process.hrtime.bigint()}@g.us`
const ADMIN = "628110000011"
const STRANGER = "628119999911"

// Every case below is rejected before a single byte is downloaded, so these
// stubs never have to behave like WhatsApp. If a gate ever regresses the
// download would throw here, which is a loud enough failure.
const sock = {} as WASocket
const message = {} as WAMessage

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await addBotAdmin({ number: ADMIN, label: "owner", canConnect: true })
  await upsertGroup({ jid: JID, name: "Jastip" })
})

after(async () => {
  await sql`DELETE FROM wa_groups WHERE jid = ${JID}`
  await sql`DELETE FROM wa_admins WHERE number = ${ADMIN}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

function attempt(sender: string) {
  return capturePost({
    sock,
    message,
    groupJid: JID,
    messageId: "m1",
    sender: `${sender}@s.whatsapp.net`,
    caption: "",
  })
}

test("a photo sent outside a capture window is just a photo", async () => {
  await closeCapture(JID)
  await bindGroupToEvent(JID, EVENT)
  assert.equal(await attempt(ADMIN), null)
})

test("a customer's photo is never a post, window or no window", async () => {
  await openCapture(JID, "Nishimatsuya")
  await bindGroupToEvent(JID, EVENT)
  assert.equal(await attempt(STRANGER), null)
})

test("an unbound group has nowhere to file a post", async () => {
  await openCapture(JID, "Nishimatsuya")
  await bindGroupToEvent(JID, null)
  assert.equal(await attempt(ADMIN), null, "no event means no post, rather than a guess")
})
