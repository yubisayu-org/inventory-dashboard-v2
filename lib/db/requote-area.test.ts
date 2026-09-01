import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { requoteCustomerArea, type RateFetcher } from "./requote-area"

/**
 * Re-pricing a customer the moment her area changes.
 *
 * Changing the area drops her stored quote -- it was bought for the area she
 * has left. Right, and it used to leave her on the fallback until the next
 * sweep. Twenty-eight customers have a fallback of zero, so for them that meant
 * a parcel shipping free.
 *
 * These tests never reach Biteship — the fetcher is injected, so a suite that
 * anybody can run does not quietly bill the courier. What they pin is the half that must not
 * reach it: a quote belongs to an AREA, not a person, so a neighbour already
 * quoted for that area answers for free. Asking is billed and is the last
 * resort. The invariant is the same one that caught every stale rate in the
 * August sweep -- two customers in one area carry the same figure.
 */

const TAG = `requote${process.hrtime.bigint()}`
const NEIGHBOUR = `${TAG}_neighbour`
const MOVER = `${TAG}_mover`
const LONER = `${TAG}_loner`
const AREA = `IDNP${TAG}`
const EMPTY_AREA = `IDNP${TAG}_nobody`

let WAREHOUSES: { id: number; origin: string | null }[] = []
let asks = 0

/** Stands in for the courier. Counts what would have been paid for. */
const refuses: RateFetcher = async () => { asks++; return null }
const answers = (price: number): RateFetcher => async () => { asks++; return price }
const ids: number[] = []

async function seed(handle: string, areaId: string | null, quote: number | null) {
  const [c] = (await sql`
    INSERT INTO customers (instagram_id, biteship_area_id)
    VALUES (${handle}, ${areaId}) RETURNING id
  `) as unknown as { id: number }[]
  ids.push(c.id)
  for (const w of WAREHOUSES) {
    await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim, biteship_ongkir)
      VALUES (${c.id}, ${w.id}, 0, ${quote})
    `
  }
  return c.id
}

async function quoteOf(customerId: number, warehouseId: number) {
  const [r] = (await sql`
    SELECT biteship_ongkir FROM customer_warehouse_ongkir
     WHERE customer_id = ${customerId} AND warehouse_id = ${warehouseId}
  `) as unknown as { biteship_ongkir: number | null }[]
  return r?.biteship_ongkir ?? null
}

test("setup", async () => {
  WAREHOUSES = (await sql`
    SELECT id, biteship_area_id AS origin FROM warehouses ORDER BY id
  `) as unknown as { id: number; origin: string | null }[]
  assert.ok(WAREHOUSES.length > 0)
  // Somebody already living in the area, already priced.
  await seed(NEIGHBOUR, AREA, 14000)
})

test("a neighbour's quote answers for free", async () => {
  const mover = await seed(MOVER, AREA, null)
  asks = 0
  const applied = await requoteCustomerArea(mover, AREA, refuses)

  assert.ok(applied.length > 0, "she was priced")
  assert.ok(applied.every((a) => !a.asked), "and nothing was bought to do it")
  assert.equal(asks, 0, "the courier was never asked")
  for (const w of WAREHOUSES.filter((x) => x.origin)) {
    assert.equal(await quoteOf(mover, w.id), 14000, "two customers in one area carry the same figure")
  }
})

test("an area nobody has ever quoted has to be bought", async () => {
  const loner = await seed(LONER, EMPTY_AREA, null)
  asks = 0
  const applied = await requoteCustomerArea(loner, EMPTY_AREA, answers(31000))
  assert.equal(asks, WAREHOUSES.filter((w) => w.origin).length, "once per origin, no more")
  assert.ok(applied.every((a) => a.asked))
  for (const w of WAREHOUSES.filter((x) => x.origin)) {
    assert.equal(await quoteOf(loner, w.id), 31000)
  }
})

test("a courier that will not answer leaves her with nothing rather than a guess", async () => {
  // A timeout, a 500, no key configured: all the same answer here. She keeps no
  // quote, and the "No rate" filter is what picks her up.
  const mute = await seed(`${TAG}_mute`, EMPTY_AREA + "_x", null)
  const applied = await requoteCustomerArea(mute, EMPTY_AREA + "_x", refuses)
  assert.deepEqual(applied, [], "nothing invented")
  for (const w of WAREHOUSES) {
    assert.equal(await quoteOf(mute, w.id), null)
  }
})

test("her own stale figure is never used as the answer", async () => {
  // The customer being re-priced is excluded from the neighbour lookup: she is
  // the one whose area just changed, so whatever she carries describes where
  // she used to live. `iinkaila` carried Medan's 47.000 to Pondok Aren.
  const ownArea = `${EMPTY_AREA}_alone`
  const stale = await seed(`${TAG}_stale`, ownArea, 47000)
  const applied = await requoteCustomerArea(stale, ownArea, refuses)
  assert.deepEqual(applied, [], "no neighbour, no quote — not her own old one")
})

test("an empty area id does nothing at all", async () => {
  asks = 0
  const applied = await requoteCustomerArea(ids[0], "   ", refuses)
  assert.deepEqual(applied, [], "a save with no area picked must not reach the courier")
  assert.equal(asks, 0)
})

test("re-pricing cannot throw, whatever the courier does", async () => {
  // It runs after the save has committed. A failure here must never look like
  // a failed save.
  const throws: RateFetcher = async () => { throw new Error("courier is down") }
  await assert.doesNotReject(() => requoteCustomerArea(ids[0], `${EMPTY_AREA}_down`, throws))
})

after(async () => {
  if (ids.length > 0) {
    await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ANY(${ids})`
    await sql`DELETE FROM customers WHERE id = ANY(${ids})`
  }
  await sql.end()
})
