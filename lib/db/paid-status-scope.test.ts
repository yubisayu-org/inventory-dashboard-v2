import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { fetchPaidStatusMap } from "./shopping-list"

/**
 * Asking about the trips on the page must answer what asking about all of them
 * would have answered for those trips.
 *
 * The receiving list sorts each product's customers by whether they have paid,
 * and used to fetch that for every invoice the shop has ever raised. It reads
 * only the trips its own items name, so it now asks for those -- and this is
 * the invariant that makes the narrower question safe.
 */
const TAG = `paidscope${process.hrtime.bigint()}`
const EV1 = `${TAG}_EV1`
const EV2 = `${TAG}_EV2`

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    SELECT id FROM products WHERE COALESCE(gram, 0) = 0 ORDER BY id LIMIT 1`
  for (const e of [EV1, EV2]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  for (const [n, paid] of [[1, 0], [2, 100000], [3, 250000]] as const) {
    const who = `${TAG}_${n}`
    await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
    await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
      SELECT c.id, w.id, 10000 FROM customers c CROSS JOIN warehouses w
       WHERE c.instagram_id = ${who} ON CONFLICT (customer_id, warehouse_id) DO NOTHING`
    for (const e of [EV1, EV2]) {
      await sql`INSERT INTO orders (event, customer, product_id, unit_price, unit)
                VALUES (${e}, ${who}, ${p.id}, 100000, 2)`
    }
    if (paid > 0) {
      await sql`INSERT INTO payments (event, customer, amount, account, pay_date, is_checked)
                VALUES (${EV1}, ${who}, ${paid}, 'BCA', CURRENT_DATE, true)`
    }
  }
})

after(async () => {
  await sql`DELETE FROM payments WHERE event IN (${EV1}, ${EV2})`
  await sql`DELETE FROM orders WHERE event IN (${EV1}, ${EV2})`
  await sql`DELETE FROM events WHERE name IN (${EV1}, ${EV2})`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("the trips asked for get the same answer as asking for all of them", async () => {
  const everything = await fetchPaidStatusMap(null)
  const listed = await fetchPaidStatusMap([EV1, EV2])

  const mine = [...everything.keys()].filter((k) => k.startsWith(TAG.toLowerCase()) || k.includes(TAG))
  assert.ok(mine.length > 0, "the fixtures are in the unscoped answer")

  for (const key of mine) {
    if (!key.includes(EV1) && !key.includes(EV2)) continue
    assert.equal(listed.get(key), everything.get(key), `${key} disagreed`)
  }
  // Paid, part-paid and unpaid are all represented, so the comparison means
  // something rather than matching three identical values.
  const values = new Set(mine.map((k) => everything.get(k)))
  assert.ok(values.size >= 2, "the fixtures cover more than one payment state")
})

test("a trip nobody asked about is not in the answer", async () => {
  const one = await fetchPaidStatusMap([EV1])
  assert.ok([...one.keys()].every((k) => !k.includes(EV2)), "and its rows never left the database")
})

test("naming the customers answers the same for them, and nothing for the others", async () => {
  const wide = await fetchPaidStatusMap([EV1, EV2])
  const one = `${TAG}_2`.toLowerCase()
  const narrow = await fetchPaidStatusMap([EV1, EV2], [one])

  // Every key it does return agrees with the wide answer...
  for (const [k, v] of narrow) assert.equal(v, wide.get(k), `${k} disagreed`)
  // ...and the customers nobody asked about are simply not there.
  assert.ok([...narrow.keys()].every((k) => k.toLowerCase().includes(one)))
  assert.ok(narrow.size > 0 && narrow.size < wide.size, "a slice, and not an empty one")
})

test("asking about nobody is not asking about everybody", async () => {
  // The empty list is a real answer -- a page with no lines on it -- and must
  // not fall through to "every customer".
  const none = await fetchPaidStatusMap([EV1, EV2], [])
  assert.equal(none.size, 0)
})
