import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { markProductOutOfStock } from "./shopping-list"
import { getRefunds } from "./finance"

const TAG = `conc${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const WHO = `${TAG}_c`

// lydouble25's five, at her prices.
const ITEMS = [
  { name: `${TAG} PCM Cooling Towel`, price: 182000 },
  { name: `${TAG} Bottle Case`, price: 149000 },
  { name: `${TAG} Wire Tongs`, price: 144000 },
  { name: `${TAG} Bucket Hat`, price: 160000 },
  { name: `${TAG} Simple Cap`, price: 160000 },
]
const GOODS = ITEMS.reduce((n, i) => n + i.price, 0)   // 795_000
const productIds: number[] = []

before(async () => {
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  for (const it of ITEMS) {
    const [p] = await sql<{ id: number }[]>`
      INSERT INTO products (name, gram, price) VALUES (${it.name}, 0, ${it.price}) RETURNING id`
    productIds.push(p.id)
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${EV}, ${WHO}, ${p.id}, ${it.price}, 1)`
  }
  // Paid in full, so every rupiah of a reduction becomes surplus.
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${WHO}, ${GOODS}, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})`
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("five products marked at once refund their own value, not each other's", async () => {
  // In production this happened in 120ms: five marks in flight, each pricing
  // its refund against an invoice the other four had already reduced. Five
  // refunds totalling Rp 3.473.000 against a surplus of Rp 795.000.
  await Promise.all(productIds.map((id) =>
    markProductOutOfStock({ event: EV, productId: id, quantityOutOfStock: 1 }, "tester")))

  const refunds = await getRefunds({ event: EV })
  const total = refunds.reduce((n, r) => n + Number(r.refundAmount), 0)

  assert.equal(refunds.length, 1, "one refund for her, however many products were marked")
  assert.equal(
    total, GOODS,
    "and it comes to what the goods were worth, not to a multiple of it",
  )

  // The note grew into the list of what it covers, so the message can name
  // every item rather than whichever mark happened to write last.
  const note = String(refunds[0].note ?? "")
  for (const it of ITEMS) {
    assert.ok(note.includes(it.name), `${it.name} is named on the refund`)
  }
})

test("marking one at a time grows one refund and tells her the running total", async () => {
  // How the shopping list is actually worked: a product at a time, minutes or
  // days apart. She gets a notice each time -- a message already sent cannot be
  // edited -- but each says what she is owed in total and everything it covers,
  // so the last one she reads is the whole story.
  const EV2 = `${TAG}_SEQ`
  const WHO2 = `${TAG}_seq`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV2}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO2})`
  const ids: number[] = []
  for (const it of ITEMS.slice(0, 3)) {
    const [p] = await sql<{ id: number }[]>`
      INSERT INTO products (name, gram, price) VALUES (${it.name + " seq"}, 0, ${it.price}) RETURNING id`
    ids.push(p.id)
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${EV2}, ${WHO2}, ${p.id}, ${it.price}, 1)`
  }
  const paid = ITEMS.slice(0, 3).reduce((n, i) => n + i.price, 0)
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV2}, ${WHO2}, ${paid}, true, 'deposit')`

  const running: number[] = []
  for (const id of ids) {
    await markProductOutOfStock({ event: EV2, productId: id, quantityOutOfStock: 1 }, "tester")
    const rows = await getRefunds({ event: EV2 })
    assert.equal(rows.length, 1, "still one refund, however many marks have run")
    running.push(Number(rows[0].refundAmount))
  }

  assert.deepEqual(running, [182000, 331000, 475000], "the row grows with each mark")

  // And each notice quoted the total as it stood, not that one item's price.
  const notes = await sql<{ body: string }[]>`
    SELECT an.body FROM announcements an JOIN customers c ON c.id = an.customer_id
     WHERE lower(replace(c.instagram_id,'@','')) = ${WHO2.toLowerCase()}
     ORDER BY an.id`
  assert.equal(notes.length, 3, "one notice per mark")
  assert.ok(notes[0].body.includes("182.000"), "first: what she was owed then")
  assert.ok(notes[2].body.includes("475.000"), "last: the whole story")
})
