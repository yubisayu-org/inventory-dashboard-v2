import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { markProductArrived } from "./fulfillment"
import { bulkUpdateArrive } from "./orders"
import { withActor } from "./actor"
import { getBoxCargo, getCargo } from "./cargo"

/**
 * Recording the delivery while counting, without asking forty times.
 *
 * The cargo is stamped on the order rows a batch actually fills, in the same
 * write as the count. Nothing back-fills: a batch that names no cargo leaves
 * its rows blank, which is exactly why the arrival form looks up the box's
 * cargo and prefills it before anyone types.
 */
const TAG = `cargocap${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const BOX = `${TAG}-14`
const CARGO = `${TAG}-9981`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    SELECT id FROM products WHERE COALESCE(gram, 0) = 0 ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const who = `${TAG}_${n}`
    await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, dispatch_receipt)
      VALUES (${EVENT}, ${who}, ${productId}, 100000, 2, 2, 2, ${BOX})`
  }
})

after(async () => {
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql`DELETE FROM cargos WHERE receipt = ${CARGO}`
  await sql.end()
})

test("counting units in records the delivery beside the box", async () => {
  await markProductArrived({
    event: EVENT, productId, quantityArrived: 2, receipt: BOX, cargo: CARGO,
  }, "tester")

  // Which is what the form reads back, so the next batch into this box is not
  // asked again -- it is shown the answer.
  assert.equal(await getBoxCargo(BOX), CARGO.toUpperCase())

  const c = (await getCargo(CARGO))!
  assert.equal(c.received, 2)
  assert.deepEqual(c.boxes.map((b) => b.receipt), [BOX])
  assert.deepEqual(c.events, [EVENT])
})

test("a batch that names no cargo neither claims units nor unsays the box's", async () => {
  await markProductArrived({ event: EVENT, productId, quantityArrived: 2, receipt: BOX }, "tester")

  assert.equal(await getBoxCargo(BOX), CARGO.toUpperCase(), "the box still belongs to that delivery")
  assert.equal((await getCargo(CARGO))!.received, 2, "but the unnamed units are not counted into it")
})

test("the bulk form's one field covers every line in the batch", async () => {
  const rows = (await sql`
    SELECT id, COALESCE(unit_arrive, 0)::int AS arrived FROM orders
     WHERE event = ${EVENT} AND COALESCE(unit_arrive, 0) < unit_dispatch ORDER BY id`
  ) as unknown as { id: number; arrived: number }[]
  assert.ok(rows.length >= 2, "a batch worth calling a batch")

  const before = (await getCargo(CARGO))!.received
  await withActor("tester", (tx) => bulkUpdateArrive(
    rows.map((r) => ({ rowNumber: r.id, unitArrive: r.arrived + 1 })), tx, CARGO))

  assert.equal((await getCargo(CARGO))!.received, before + rows.length, "one answer, every line")
})

test("a blank cargo on a bulk save changes nothing a row already said", async () => {
  const [row] = (await sql`
    SELECT id, COALESCE(unit_arrive, 0)::int AS arrived FROM orders
     WHERE event = ${EVENT} AND COALESCE(unit_arrive, 0) < unit_dispatch
       AND cargo_receipt <> '' ORDER BY id LIMIT 1`
  ) as unknown as { id: number; arrived: number }[]

  const before = (await getCargo(CARGO))!.received
  await withActor("tester", (tx) => bulkUpdateArrive(
    [{ rowNumber: row.id, unitArrive: row.arrived + 1 }], tx, ""))

  // The row kept the cargo it already carried, so the extra unit counts.
  assert.equal((await getCargo(CARGO))!.received, before + 1)
})
