import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { eventNoticeRecipients, notifyEventCustomers, listAnnouncementsForCustomer } from "./announcements"

const TAG = `evnotice${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const OTHER = `${TAG}_EV2`
const WAITING = `${TAG}_waiting`
const PARTLY = `${TAG}_partly`
const SHIPPED = `${TAG}_shipped`
const ELSEWHERE = `${TAG}_elsewhere`
let productId = 0

async function order(event: string, who: string, unit: number, shipped: number) {
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_ship)
    VALUES (${event}, ${who}, ${productId}, 100000, ${unit}, ${unit}, ${shipped})`
}

async function idOf(who: string) {
  const [c] = await sql<{ id: number }[]>`SELECT id FROM customers WHERE instagram_id = ${who}`
  return c.id
}

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  for (const e of [EVENT, OTHER]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  for (const who of [WAITING, PARTLY, SHIPPED, ELSEWHERE]) {
    await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
  }
  await order(EVENT, WAITING, 3, 0)   // nothing gone
  await order(EVENT, PARTLY, 3, 1)    // some gone, some still in the cargo
  await order(EVENT, SHIPPED, 2, 2)   // all gone
  await order(OTHER, ELSEWHERE, 1, 0) // a different trip entirely
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("it reaches the trip, and nobody else's", async () => {
  const who = (await eventNoticeRecipients(EVENT)).map((r) => r.customer)
  assert.ok(who.includes(WAITING))
  assert.ok(who.includes(PARTLY), "some of hers is still in that cargo")
  assert.ok(!who.includes(ELSEWHERE), "a different trip is not this news")
})

test("whoever already has their parcel is left out", async () => {
  // Their box is not in that cargo. A delay notice they cannot act on is a
  // false alarm, and it costs the next real one its credibility.
  const who = (await eventNoticeRecipients(EVENT)).map((r) => r.customer)
  assert.ok(!who.includes(SHIPPED))

  const all = (await eventNoticeRecipients(EVENT, false)).map((r) => r.customer)
  assert.ok(all.includes(SHIPPED), "unless you say to include them")
})

test("everyone on the trip gets their own copy", async () => {
  const result = await notifyEventCustomers(EVENT, {
    title: `${EVENT} is running late`,
    body: "The cargo has been held at customs. We will tell you when it moves.",
  })
  assert.equal(result.sent, 2)

  for (const who of [WAITING, PARTLY]) {
    const inbox = await listAnnouncementsForCustomer(await idOf(who))
    assert.ok(inbox.some((a) => a.title.includes(EVENT)), who)
  }
  // Personal, not global: read state is per person, and one shared row would
  // be read by whoever opened it first and unread for everybody else.
  const untouched = await listAnnouncementsForCustomer(await idOf(ELSEWHERE))
  assert.equal(untouched.filter((a) => a.title.includes(EVENT)).length, 0)
})

test("a trip nobody ordered on sends nothing", async () => {
  const result = await notifyEventCustomers(`${TAG}_ghost`, { title: "x", body: "y" })
  assert.deepEqual(result, { sent: 0, customers: [] })
})

// A reminder is only news to somebody who owes, and it has to name her own
// figure — one notice, forty different amounts.
test("a reminder reaches only those who owe, each with their own figures", async () => {
  const all = await eventNoticeRecipients(EVENT, { skipShipped: false })
  assert.ok(all.length >= 2, "the fixture has more than one customer on this trip")
  for (const r of all) {
    assert.equal(typeof r.total, "number", "the invoice total travels with each recipient")
    assert.equal(typeof r.outstanding, "number")
  }

  const owing = await eventNoticeRecipients(EVENT, { skipShipped: false, onlyUnpaid: true })
  for (const r of owing) {
    assert.ok(r.outstanding > 0, "nobody who has paid is on the list")
  }

  // The figures come from live_balances, which is what her invoice reads, so a
  // reminder can never quote a number the invoice disagrees with.
  const [fromView] = await sql<{ balance: number }[]>`
    SELECT balance FROM live_balances
     WHERE event = ${EVENT}
       AND lower(replace(customer, '@', '')) = ${all[0].customer.toLowerCase().replace("@", "")}`
  if (fromView) assert.equal(all[0].outstanding, Number(fromView.balance))
})

test("each recipient reads her own amount, not the first one's", async () => {
  const owing = await eventNoticeRecipients(EVENT, { skipShipped: false, onlyUnpaid: true })
  if (owing.length === 0) return

  await notifyEventCustomers(
    EVENT,
    { title: "{event} still waiting", body: "{customer}: {outstanding} of {total} to go." },
    { skipShipped: false, onlyUnpaid: true },
  )

  for (const r of owing) {
    const inbox = await listAnnouncementsForCustomer(r.customer)
    const mine = inbox.find((a) => a.title.includes(EVENT) && a.body.includes("to go"))
    assert.ok(mine, `${r.customer} got the notice`)
    assert.match(mine.body, new RegExp(r.outstanding.toLocaleString("id-ID").replace(/\./g, "\\.")))
    assert.match(mine.body, new RegExp(r.customer))
  }
})
