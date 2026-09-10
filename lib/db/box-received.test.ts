import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { withActor } from "./actor"
import { recordDispatchManifest, getBoxManifest } from "./dispatch-manifest"

/**
 * What a box received, when the receipt was typed wrong and fixed afterwards.
 *
 * CJI-04's shape: 64 units packed, 58 counted in under its own code, and six
 * counted while the screen said "Bix 4". The order rows were corrected later;
 * the arrival history was not, and never will be -- it records what happened.
 *
 * So `received` reads the history for the counts and the orders for the box,
 * and the six land where the correction put them.
 */
const TAG = `boxrec${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const BOX = `${TAG}-04`
const TYPO = `${TAG}-BIX4`
let productId = 0
let heavyOrder = 0
let typoOrder = 0

async function seed(customer: string, units: number, receipt: string) {
  await sql`INSERT INTO customers (instagram_id) VALUES (${customer})`
  const [o] = (await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, dispatch_receipt)
    VALUES (${EVENT}, ${customer}, ${productId}, 100000, ${units}, ${units}, ${units}, ${receipt})
    RETURNING id`) as unknown as { id: number }[]
  return o.id
}

/** Count units in the way arrival does, so the audit log gets its rows. */
async function countIn(orderId: number, units: number) {
  await withActor("tester", (tx) => tx`
    UPDATE orders SET unit_arrive = COALESCE(unit_arrive, 0) + ${units}, updated_at = NOW()
     WHERE id = ${orderId}`)
}

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    SELECT id FROM products WHERE COALESCE(gram, 0) = 0 ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  await recordDispatchManifest([{ event: EVENT, productId, receipt: BOX, qty: 10 }])
  heavyOrder = await seed(`${TAG}_a`, 6, BOX)
  typoOrder = await seed(`${TAG}_b`, 4, TYPO)
})

after(async () => {
  await sql`DELETE FROM dispatch_manifest WHERE event = ${EVENT}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("a box in transit has everything assigned and nothing received", async () => {
  const m = (await getBoxManifest(BOX))!
  assert.equal(m.packedTotal, 10)
  assert.equal(m.assignedTotal, 6, "only this box's own orders claim it")
  assert.equal(m.receivedTotal, 0, "nothing counted in yet")
  assert.equal(m.unaccounted, 10, "which is what an unopened box looks like")
})

test("counting units in raises received, not assigned", async () => {
  await countIn(heavyOrder, 6)
  const m = (await getBoxManifest(BOX))!
  assert.equal(m.assignedTotal, 6, "unchanged — assignment happened at packing")
  assert.equal(m.receivedTotal, 6)
  assert.equal(m.unaccounted, 4, "the four counted under the typo are still missing")
})

test("units counted under a typo belong to the box the order was corrected to", async () => {
  // Counted while the screen said the wrong code…
  await countIn(typoOrder, 4)
  const before = (await getBoxManifest(BOX))!
  assert.equal(before.receivedTotal, 6, "they are not this box's yet")

  // …then the receipt on those order rows is fixed.
  await sql`UPDATE orders SET dispatch_receipt = ${BOX} WHERE id = ${typoOrder}`

  const after = (await getBoxManifest(BOX))!
  assert.equal(after.receivedTotal, 10, "the four follow the correction")
  assert.equal(after.assignedTotal, 10)
  assert.equal(after.unaccounted, 0, "and the box stops reading short")

  const typoBox = await getBoxManifest(TYPO)
  assert.equal(typoBox, null, "the ghost receipt no longer exists")
})
