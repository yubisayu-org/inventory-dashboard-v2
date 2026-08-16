import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../lib/db-pool"
import { addBotAdmin, currentCapture, listGroups } from "../lib/db/whatsapp-groups"
import { senderJid, senderNumber, runCommand } from "./handle-command"

const EVENT = `TESTCMD${process.hrtime.bigint()}`
const JID = `${process.hrtime.bigint()}@g.us`
const OWNER = "628110000001"
const HELPER = "628110000002"
const STRANGER = "628119999999"

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await addBotAdmin({ number: OWNER, label: "owner", canConnect: true })
  await addBotAdmin({ number: HELPER, label: "helper", canConnect: false })
})

after(async () => {
  await sql`DELETE FROM wa_groups WHERE jid = ${JID}`
  await sql`DELETE FROM wa_admins WHERE number IN (${OWNER}, ${HELPER})`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("a sender's number is read out of the JID however it is shaped", () => {
  assert.equal(senderNumber("628110000001@s.whatsapp.net"), "628110000001")
  assert.equal(senderNumber("628110000001:12@s.whatsapp.net"), "628110000001")
  assert.equal(senderNumber("628110000001@lid"), "628110000001")
  assert.equal(senderNumber(""), "")
})

test("a privacy id never stands in for a real number", () => {
  // Observed on a live account: WhatsApp sends the participant as an @lid
  // identifier and the real number alongside it. Reading the participant would
  // look up 104428539535560, miss, and silently ignore the owner's own command.
  assert.equal(
    senderJid({
      remoteJid: "120363412732437859@g.us",
      participant: "104428539535560@lid",
      participantPn: "62811905159@s.whatsapp.net",
      fromMe: false,
      id: "x",
    }),
    "62811905159@s.whatsapp.net",
  )
  assert.equal(
    senderNumber(
      senderJid({ participant: "104428539535560@lid", participantPn: "62811905159@s.whatsapp.net" }),
    ),
    "62811905159",
  )
})

test("an account that still sends a plain JID keeps working", () => {
  assert.equal(
    senderJid({ participant: "628110000001@s.whatsapp.net" }),
    "628110000001@s.whatsapp.net",
  )
  assert.equal(senderJid(null), "")
  assert.equal(senderJid({}), "")
})

test("a stranger's command does nothing at all", async () => {
  const result = await runCommand({
    command: { kind: "rekap" },
    groupJid: JID,
    groupName: "Jastip",
    sender: `${STRANGER}@s.whatsapp.net`,
  })
  assert.deepEqual(result, {}, "no reply, no reaction — a stranger gets silence")
})

test("only a connector may bind a group", async () => {
  const denied = await runCommand({
    command: { kind: "connect" },
    groupJid: JID,
    groupName: "Jastip",
    sender: `${HELPER}@s.whatsapp.net`,
  })
  assert.deepEqual(denied, {}, "an admin who is not a connector is ignored too")

  const allowed = await runCommand({
    command: { kind: "connect" },
    groupJid: JID,
    groupName: "Jastip",
    sender: `${OWNER}@s.whatsapp.net`,
  })
  assert.ok(allowed.reply, "the connector gets told what happened")

  const group = (await listGroups()).find((g) => g.jid === JID)
  assert.ok(group, "connecting registers the group even when it cannot pick an event")
  assert.equal(group.name, "Jastip")
})

test("opening a window records the store and reacts rather than replying", async () => {
  const result = await runCommand({
    command: { kind: "open", store: "Nishimatsuya" },
    groupJid: JID,
    groupName: "Jastip",
    sender: `${OWNER}@s.whatsapp.net`,
  })
  assert.ok(result.react, "a reaction, not a message — the group does not need the noise")
  assert.equal(result.reply, undefined)

  const open = await currentCapture(JID)
  assert.equal(open?.store, "Nishimatsuya")
})

test("closing a window ends it", async () => {
  await runCommand({
    command: { kind: "open", store: "Loft" },
    groupJid: JID, groupName: "Jastip", sender: `${OWNER}@s.whatsapp.net`,
  })
  await runCommand({
    command: { kind: "close" },
    groupJid: JID, groupName: "Jastip", sender: `${OWNER}@s.whatsapp.net`,
  })
  assert.equal(await currentCapture(JID), null)
})

test("a helper may pull the shopping list and open a window", async () => {
  const rekap = await runCommand({
    command: { kind: "rekap" },
    groupJid: JID, groupName: "Jastip", sender: `${HELPER}@s.whatsapp.net`,
  })
  assert.equal(rekap.rekap, true)

  const open = await runCommand({
    command: { kind: "open", store: "Muji" },
    groupJid: JID, groupName: "Jastip", sender: `${HELPER}@s.whatsapp.net`,
  })
  assert.ok(open.react, "capturing is admin work, and a helper is an admin")
})
