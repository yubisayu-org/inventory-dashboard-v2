import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getShipOrdersFiltered } from "./fulfillment"

/**
 * The tab is a filter on the answer, not a question of its own.
 *
 * Every segment runs the same four reads -- order lines, ongkir, customer
 * details, payment status -- and differs only in a final `if`. That is why the
 * Ship screen now fetches the trip once and applies the tab in the browser: a
 * tab click used to re-read every order line ever recorded, about 1.8MB, to
 * show a subset of what it already had.
 *
 * If this ever stops being true -- if a segment starts being pushed down into
 * SQL, or the counts start depending on which tab asked -- the screen would
 * quietly show the wrong badge numbers. So it is asserted here rather than
 * remembered.
 */
const TAG = `shipseg${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  // One card with nothing landed, one part-landed, one fully landed.
  for (const [n, arrived] of [[1, 0], [2, 3], [3, 6]] as const) {
    const who = `${TAG}_${n}`
    await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
    await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
      SELECT c.id, w.id, 10000 FROM customers c CROSS JOIN warehouses w
       WHERE c.instagram_id = ${who}
      ON CONFLICT (customer_id, warehouse_id) DO NOTHING`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
      VALUES (${EVENT}, ${who}, ${p.id}, 100000, 6, ${arrived})`
  }
})

after(async () => {
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("the badge counts are the same whichever tab asked", async () => {
  const all = await getShipOrdersFiltered({ segment: "all", event: EVENT })
  for (const seg of ["not_arrived", "partial", "ready", "shipped"] as const) {
    const one = await getShipOrdersFiltered({ segment: seg, event: EVENT })
    assert.deepEqual(one.counts, all.counts, `counts moved when asked as ${seg}`)
  }
})

test("a tab's cards are exactly the whole trip filtered by status", async () => {
  const all = await getShipOrdersFiltered({ segment: "all", event: EVENT })
  assert.ok(all.groups.length >= 3, "the fixtures are on the screen")

  for (const seg of ["not_arrived", "partial", "ready", "shipped"] as const) {
    const one = await getShipOrdersFiltered({ segment: seg, event: EVENT })
    const locally = all.groups.filter((g) => g.status === seg).map((g) => g.customer).sort()
    assert.deepEqual(one.groups.map((g) => g.customer).sort(), locally,
      `the browser's own filter would disagree with the server on ${seg}`)
  }
})
