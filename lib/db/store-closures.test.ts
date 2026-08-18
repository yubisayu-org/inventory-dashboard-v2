import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { closedStores, closeStore, reopenStore } from "./store-closures"

const EVENT = `TESTSHUT${process.hrtime.bigint()}`

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
})

after(async () => {
  await sql`DELETE FROM wa_store_closures WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("a shop closes and reopens", async () => {
  await closeStore(EVENT, "Nishimatsuya")
  assert.deepEqual(await closedStores(EVENT), ["nishimatsuya"])

  await reopenStore(EVENT, "Nishimatsuya")
  assert.deepEqual(await closedStores(EVENT), [])
})

test("however the shop name was typed, it is one shop", async () => {
  // The name is typed by hand each time a capture window opens, so the same
  // shop arrives spelled three ways across one trip.
  await closeStore(EVENT, "BIRTHDAY")
  await closeStore(EVENT, " birthday ")
  assert.deepEqual(await closedStores(EVENT), ["birthday"], "closing twice is closing once")

  await reopenStore(EVENT, "Birthday")
  assert.deepEqual(await closedStores(EVENT), [], "and reopening finds it whatever the case")
})

test("closing one shop leaves the others open", async () => {
  await closeStore(EVENT, "Nishimatsuya")
  const closed = await closedStores(EVENT)
  assert.deepEqual(closed, ["nishimatsuya"])
  assert.ok(!closed.includes("birthday"), "the trip carries on elsewhere")
  await reopenStore(EVENT, "Nishimatsuya")
})

test("an empty name closes nothing", async () => {
  await closeStore(EVENT, "   ")
  assert.deepEqual(await closedStores(EVENT), [], "a store-less shelf cannot close a trip")
})
