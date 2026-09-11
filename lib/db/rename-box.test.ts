import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { renameDispatchReceipt } from "./fulfillment"
import { recordDispatchManifest, getBoxManifest, getEventBoxes } from "./dispatch-manifest"

/**
 * Renaming a box moves the whole box.
 *
 * Until 11 Sep 2026 it moved the orders and left what was packed behind, which
 * split the box in two: the manifest went on saying goods were packed in the
 * old name and never received, while the new name showed goods received that
 * nothing was ever packed for. Nineteen codes in production are stranded that
 * way -- "Bix 9, Box 9" among them, which is what a correction looked like.
 */
const TAG = `renamebox${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const WRONG = `${TAG}-BIX9`
const RIGHT = `${TAG}-CJI09`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${TAG})`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, dispatch_receipt)
    VALUES (${EVENT}, ${TAG}, ${productId}, 100000, 5, 5, 5, ${WRONG})`
  await recordDispatchManifest([{ event: EVENT, productId, receipt: WRONG, qty: 5 }])
})

after(async () => {
  await sql`DELETE FROM dispatch_manifest WHERE event = ${EVENT}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${TAG}`
  await sql.end()
})

test("what was packed follows the orders to the new name", async () => {
  const before = (await getBoxManifest(WRONG))!
  assert.equal(before.packedTotal, 5)

  const { moved, packedMoved } = await renameDispatchReceipt(WRONG, RIGHT)
  assert.equal(moved, 1, "the order line")
  assert.equal(packedMoved, 1, "and the manifest row that used to be left behind")

  const after = (await getBoxManifest(RIGHT))!
  assert.equal(after.packedTotal, 5, "the new name carries what was packed")
  assert.equal(await getBoxManifest(WRONG), null, "and the old name is not a second box")

  // The strip is where a stranded half would show up as a parcel in transit
  // that never arrives.
  const cards = await getEventBoxes(EVENT)
  assert.deepEqual(cards.map((c) => c.receipt), [RIGHT])
})

test("a rename that only changes case is not a rename", async () => {
  const { moved, packedMoved } = await renameDispatchReceipt(RIGHT.toLowerCase(), RIGHT)
  assert.equal(moved, 0)
  assert.equal(packedMoved, 0)
  assert.equal((await getBoxManifest(RIGHT))!.packedTotal, 5, "and nothing was disturbed")
})

test("the code is matched however it was typed", async () => {
  const FINAL = `${TAG}-CJI10`
  const { moved, packedMoved } = await renameDispatchReceipt(RIGHT.toLowerCase(), FINAL)
  assert.equal(moved, 1, "lower case found the box")
  assert.equal(packedMoved, 1)
  assert.equal((await getBoxManifest(FINAL))!.packedTotal, 5)
})
