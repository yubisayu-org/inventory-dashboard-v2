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
  // Nothing landed, part-landed, all landed and still to send, and one with
  // nothing left to do at all -- the card the working tabs cannot show.
  for (const [n, arrived, shipped] of [[1, 0, 0], [2, 3, 0], [3, 6, 0], [4, 6, 6]] as const) {
    const who = `${TAG}_${n}`
    await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
    await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
      SELECT c.id, w.id, 10000 FROM customers c CROSS JOIN warehouses w
       WHERE c.instagram_id = ${who}
      ON CONFLICT (customer_id, warehouse_id) DO NOTHING`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive, unit_ship)
      VALUES (${EVENT}, ${who}, ${p.id}, 100000, 6, ${arrived}, ${shipped})`
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

test("a finished card is not read unless a tab can show it", async () => {
  const withAll = await getShipOrdersFiltered({ segment: "all", event: EVENT })
  const done = withAll.groups.filter((g) => g.status === "shipped")
  assert.equal(done.length, 1, "the fixture has one card with nothing left to do")

  const working = await getShipOrdersFiltered({ segment: "all", event: EVENT, includeShipped: false })
  assert.ok(!working.groups.some((g) => g.status === "shipped"), "it was left in the database")

  // And nothing else moved: the seven working tabs see exactly what they saw.
  const same = (list: typeof withAll.groups) =>
    list.filter((g) => g.status !== "shipped").map((g) => `${g.customer}|${g.status}`).sort()
  assert.deepEqual(same(working.groups), same(withAll.groups))
  for (const seg of ["not_arrived", "partial", "ready", "ready_unpaid", "hold", "split_requested", "paired"] as const) {
    assert.equal(working.counts[seg], withAll.counts[seg], `the ${seg} badge moved`)
  }
})

test("a part-shipped card is still work, and is still read", async () => {
  const who = `${TAG}_part`
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    SELECT c.id, w.id, 10000 FROM customers c CROSS JOIN warehouses w
     WHERE c.instagram_id = ${who} ON CONFLICT (customer_id, warehouse_id) DO NOTHING`
  // Everything arrived, half of it gone: there is still a box to send.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive, unit_ship)
    VALUES (${EVENT}, ${who}, ${p.id}, 100000, 6, 6, 3)`

  const working = await getShipOrdersFiltered({ segment: "all", event: EVENT, includeShipped: false })
  const card = working.groups.find((g) => g.customer.includes("_part"))
  assert.ok(card, "half-shipped is not shipped")
  assert.equal(card!.totalToShip, 3, "and its remaining units are intact")
})
