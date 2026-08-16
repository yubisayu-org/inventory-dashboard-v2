import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  upsertGroup, bindGroupToEvent, listGroups,
  addBotAdmin, removeBotAdmin, isBotAdmin, canConnect,
  openCapture, closeCapture, currentCapture,
} from "./whatsapp-groups"

const EVENT = `TESTGRP${process.hrtime.bigint()}`
const JID = `${process.hrtime.bigint()}@g.us`
const NUMBER = `62811${process.hrtime.bigint()}`.slice(0, 15)

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
})

after(async () => {
  await sql`DELETE FROM wa_groups WHERE jid = ${JID}`
  await sql`DELETE FROM wa_admins WHERE number = ${NUMBER}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("a group is bound to an event, not recreated per trip", async () => {
  await upsertGroup({ jid: JID, name: "Jastip Agustus" })
  await bindGroupToEvent(JID, EVENT)

  const group = (await listGroups()).find((g) => g.jid === JID)
  assert.ok(group)
  assert.equal(group.event, EVENT)
  assert.equal(group.name, "Jastip Agustus")

  // Re-upserting refreshes the cached name without unbinding the event.
  await upsertGroup({ jid: JID, name: "Jastip Agustus (2)" })
  const again = (await listGroups()).find((g) => g.jid === JID)
  assert.equal(again?.name, "Jastip Agustus (2)")
  assert.equal(again?.event, EVENT, "renaming a group must not detach its event")
})

test("only a can_connect number may bind a group", async () => {
  await addBotAdmin({ number: NUMBER, label: "helper", canConnect: false })
  assert.equal(await isBotAdmin(NUMBER), true)
  assert.equal(await canConnect(NUMBER), false)

  await addBotAdmin({ number: NUMBER, label: "helper", canConnect: true })
  assert.equal(await canConnect(NUMBER), true, "re-adding updates rather than duplicating")
})

test("an unknown number is neither admin nor connector", async () => {
  assert.equal(await isBotAdmin("6280000000000"), false)
  assert.equal(await canConnect("6280000000000"), false)
})

test("a local 08 number and its 62 form are the same person", async () => {
  await addBotAdmin({ number: "081234567890", label: "owner", canConnect: true })
  assert.equal(await isBotAdmin("6281234567890"), true, "a command must not be ignored over spelling")
  assert.equal(await canConnect("+62 812-3456-7890"), true)
  await removeBotAdmin("6281234567890")
  assert.equal(await isBotAdmin("081234567890"), false)
})

test("a group has at most one open capture window", async () => {
  await upsertGroup({ jid: JID, name: "Jastip Agustus" })
  await closeCapture(JID)

  await openCapture(JID, "Nishimatsuya")
  const open = await currentCapture(JID)
  assert.ok(open)
  assert.equal(open.store, "Nishimatsuya")

  // Opening again while one is open re-points the store rather than failing:
  // the owner walked into the next shop and said so.
  await openCapture(JID, "Akachan Honpo")
  const moved = await currentCapture(JID)
  assert.equal(moved?.store, "Akachan Honpo")
  assert.equal(moved?.id, open.id, "same window, new shop")

  await closeCapture(JID)
  assert.equal(await currentCapture(JID), null)
})

test("removing an admin takes the permission with it", async () => {
  await addBotAdmin({ number: NUMBER, label: "helper", canConnect: true })
  await removeBotAdmin(NUMBER)
  assert.equal(await isBotAdmin(NUMBER), false)
})
