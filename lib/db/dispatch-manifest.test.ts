import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { recordDispatchManifest, recordExcessDispatchManifest, getBoxManifest, getEventBoxes } from "./dispatch-manifest"
import { getDispatchDocument } from "./dispatch"

/**
 * What was in the box, kept apart from who was served out of it.
 *
 * `orders.dispatch_receipt` answers the second question, and since arrival
 * started reassigning units to whoever paid first it MOVES -- so afterwards the
 * row says who ended up served, not what was packed. Survivable most days.
 * Wrong exactly when it matters: a box arrives short or the courier disputes
 * it, and what was packed is the only thing worth having.
 */

const TAG = `manif${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const BOX = `CJI-${TAG.slice(-5)}`
const OTHER = `HC-${TAG.slice(-5)}`
let penId = 0
let bagId = 0
const orderIds: number[] = []

async function seedOrder(customer: string, productId: number, unit: number, receipt: string) {
  const [o] = (await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit,
                        unit_buy, unit_dispatch, dispatch_receipt)
    VALUES (${EVENT}, ${customer}, ${productId}, 10000, ${unit},
            ${unit}, ${unit}, ${receipt})
    RETURNING id
  `) as unknown as { id: number }[]
  orderIds.push(o.id)
  return o.id
}

test("setup", async () => {
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${`${TAG}_paid`}), (${`${TAG}_later`})`
  const [pen] = (await sql`
    INSERT INTO products (name, store, price, gram) VALUES (${`${TAG} Gel Pen`}, 'MUJI', 10000, 20) RETURNING id
  `) as unknown as { id: number }[]
  const [bag] = (await sql`
    INSERT INTO products (name, store, price, gram) VALUES (${`${TAG} Tote Bag`}, 'MUJI', 90000, 400) RETURNING id
  `) as unknown as { id: number }[]
  penId = pen.id
  bagId = bag.id
})

test("a dispatch records what went in the box", async () => {
  await recordDispatchManifest([
    { event: EVENT, productId: penId, receipt: BOX, qty: 12 },
    { event: EVENT, productId: bagId, receipt: BOX, qty: 3 },
  ])
  const m = (await getBoxManifest(BOX))!
  assert.equal(m.packedTotal, 15)
  assert.deepEqual(m.lines.map((l) => [l.productName.slice(-8), l.packed]).sort(),
    [[" Gel Pen".slice(-8), 12], ["Tote Bag", 3]].sort())
})

test("a dispatch with no box named is still recorded", async () => {
  // Most of the shop's history is exactly this: goods packed, the tracking
  // number written across the box afterwards or never. Dropping them would make
  // the manifest a record of the labelled minority — and the dispatch document,
  // which reads this table, would go blank for whole trips.
  await recordDispatchManifest([{ event: EVENT, productId: penId, receipt: "   ", qty: 5 }])
  assert.equal((await getBoxManifest(BOX))!.packedTotal, 15, "but it belongs to no box")
  const doc = await getDispatchDocument(EVENT)
  assert.equal(doc.filter((d) => d.receipt === "").reduce((n, d) => n + d.qty, 0), 5,
    "the dispatch document still lists it, unlabelled")
})

test("an unnamed dispatch is not offered as a box to open", async () => {
  const boxes = await getEventBoxes(EVENT)
  assert.ok(boxes.every((b) => b.receipt.trim() !== ""), "a box nobody named cannot be opened")
})

test("a second batch into the same box adds to it", async () => {
  await recordDispatchManifest([{ event: EVENT, productId: penId, receipt: BOX, qty: 4 }])
  const m = (await getBoxManifest(BOX))!
  assert.equal(m.packedTotal, 19)
  assert.equal(m.lines.find((l) => l.productId === penId)!.packed, 16, "12 then 4")
})

test("reassigning a unit at arrival does not move the manifest", async () => {
  // The whole point. She was served out of a different box, so orders moves and
  // the manifest does not -- the box still contains what it contained.
  await seedOrder(`${TAG}_paid`, penId, 16, BOX)
  await seedOrder(`${TAG}_later`, bagId, 3, BOX)

  const before = (await getBoxManifest(BOX))!
  assert.equal(before.servedTotal, 19, "everything still reads this box")

  await sql`
    UPDATE orders SET dispatch_receipt = ${OTHER}
     WHERE event = ${EVENT} AND product_id = ${bagId}
  `

  const after = (await getBoxManifest(BOX))!
  assert.equal(after.packedTotal, 19, "what was packed cannot change")
  assert.equal(after.servedTotal, 16, "who was served can")
  const bag = after.lines.find((l) => l.productId === bagId)!
  assert.equal(bag.packed, 3)
  assert.equal(bag.served, 0, "three bags left this box for another one")
})

test("a box reads short when its goods never arrived", async () => {
  const m = (await getBoxManifest(BOX))!
  assert.equal(m.packedTotal - m.servedTotal, 3, "the difference is the question worth asking")
})

test("a box nobody ever packed has no manifest", async () => {
  assert.equal(await getBoxManifest(`${BOX}_NOPE`), null)
  assert.equal(await getBoxManifest("  "), null)
})

test("the box is matched however it was typed", async () => {
  // The code is typed by hand while packing.
  const upper = (await getBoxManifest(BOX.toUpperCase()))!
  const lower = (await getBoxManifest(BOX.toLowerCase()))!
  assert.equal(upper.packedTotal, 19)
  assert.equal(lower.packedTotal, 19)
})

test("a trip lists its boxes, biggest facts first", async () => {
  await recordDispatchManifest([{ event: EVENT, productId: penId, receipt: OTHER, qty: 2 }])
  const boxes = await getEventBoxes(EVENT)
  assert.deepEqual(boxes.map((b) => b.receipt).sort(), [BOX, OTHER].sort())
  assert.equal(boxes.find((b) => b.receipt === BOX)!.units, 19)
  assert.equal(boxes.find((b) => b.receipt === OTHER)!.units, 2)
})

test("the dispatch document reads the manifest, not the audit log", async () => {
  // Same numbers, from a table built for the question. The rows above were
  // written directly, so there is no audit trail behind them at all — if the
  // document still read the log it would come back empty.
  const doc = await getDispatchDocument(EVENT)
  const forBox = doc.filter((d) => d.receipt === BOX)
  assert.equal(forBox.reduce((n, d) => n + d.qty, 0), 19)
  assert.ok(doc.some((d) => d.receipt === OTHER), "and the other box is there too")
})

test("the dispatch document can be narrowed to one box", async () => {
  const doc = await getDispatchDocument(EVENT, BOX)
  assert.ok(doc.length > 0)
  assert.ok(doc.every((d) => d.receipt === BOX))
})

test("surplus in the same box lands on the same manifest", async () => {
  // Overbuy has no customer, so it travels through excess_purchase — into the
  // SAME parcel. A manifest built from orders alone leaves the box reading
  // light against whatever the courier weighed.
  const before = (await getBoxManifest(BOX))!.packedTotal
  const r = await recordExcessDispatchManifest(
    { event: EVENT, itemName: `${TAG} Tote Bag`, receipt: BOX, qty: 2 },
  )
  assert.equal(r.recorded, true)
  assert.equal(r.productId, bagId, "matched by name, the way ready-stock prices surplus")
  assert.equal((await getBoxManifest(BOX))!.packedTotal, before + 2)
})

test("surplus is packed, but is never counted as missing", async () => {
  // It belongs to nobody, so nothing on the orders side can ever answer for it.
  // Counting it as a shortfall would make every box carrying overbuy look short
  // on the one page built to settle whether a box WAS short.
  const m = (await getBoxManifest(BOX))!
  const bag = m.lines.find((l) => l.productId === bagId)!
  assert.equal(bag.packed, 5, "3 ordered + 2 surplus")
  assert.equal(bag.surplus, 2)
  assert.equal(bag.served, 0, "the three ordered ones went to another box earlier")

  assert.equal(m.surplusTotal, 2)
  assert.equal(
    m.unaccounted,
    m.packedTotal - m.surplusTotal - m.servedTotal,
    "what is unaccounted for excludes what nobody was owed",
  )
})

test("surplus naming nothing the catalogue knows is skipped", async () => {
  // Recorded shapelessly it would need a nullable product and a second kind of
  // row. All 70 surplus lines ever dispatched in production match by name, so
  // requiring a match costs nothing and keeps the table one shape.
  const before = (await getBoxManifest(BOX))!.packedTotal
  const r = await recordExcessDispatchManifest(
    { event: EVENT, itemName: "Something Nobody Sells", receipt: BOX, qty: 9 },
  )
  assert.equal(r.recorded, false)
  assert.equal(r.productId, null)
  assert.equal((await getBoxManifest(BOX))!.packedTotal, before, "nothing invented")
})

test("surplus dispatched without a box is not recorded either", async () => {
  const before = (await getBoxManifest(BOX))!.packedTotal
  const r = await recordExcessDispatchManifest(
    { event: EVENT, itemName: `${TAG} Tote Bag`, receipt: "  ", qty: 4 },
  )
  assert.equal(r.recorded, false)
  assert.equal((await getBoxManifest(BOX))!.packedTotal, before)
})

after(async () => {
  await sql`DELETE FROM dispatch_manifest WHERE event = ${EVENT}`
  if (orderIds.length > 0) await sql`DELETE FROM orders WHERE id = ANY(${orderIds})`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql`DELETE FROM products WHERE id = ANY(${[penId, bagId]})`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})
