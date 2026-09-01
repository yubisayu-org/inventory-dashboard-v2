import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getCustomersPaginated } from "./customers"

/**
 * Finding the customers a parcel would ship free for.
 *
 * `ongkos_kirim` has always defaulted to zero, and a MISSING row reads at the
 * invoice exactly like a stored zero -- so a customer nobody has priced bills
 * her shipping at nothing, and the invoice looks finished. Nothing in the
 * dashboard said so; `customers.ongkir_needs_review` exists but no query has
 * ever read it.
 *
 * Production today: 49 customers cannot be priced from at least one warehouse,
 * every one of them because there is no address to price from, and 15 of those
 * still have goods to ship. Nobody is stuck on an unpriceable district -- which
 * is the point. This is the net that catches the next one.
 */

const TAG = `noRate${process.hrtime.bigint()}`
const PRICED = `${TAG}_priced`
const NO_ROW = `${TAG}_norow`         // never priced from either warehouse
const ZERO = `${TAG}_zero`            // priced, at nothing
const HALF = `${TAG}_half`            // one warehouse only
const NO_ADDRESS = `${TAG}_noaddress`  // unpriceable, and nothing to price from

let WAREHOUSES: number[] = []
const ids: number[] = []

async function seed(
  handle: string,
  rates: Record<number, number>,
  address: { kota: string; kecamatan: string } | null = { kota: "BANDUNG", kecamatan: "BUAHBATU" },
) {
  // kota/kecamatan are NOT NULL and default to '' — an empty string is how the
  // table already says "no address", so that is what the filter has to read.
  const [c] = (await sql`
    INSERT INTO customers (instagram_id, kota, kecamatan)
    VALUES (${handle}, ${address?.kota ?? ""}, ${address?.kecamatan ?? ""})
    RETURNING id
  `) as unknown as { id: number }[]
  ids.push(c.id)
  for (const [wid, rate] of Object.entries(rates)) {
    await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
      VALUES (${c.id}, ${Number(wid)}, ${rate})
    `
  }
  return c.id
}

async function handles(ongkirStatus: "unpriceable" | "unpriceable_with_address") {
  const { rows } = await getCustomersPaginated({ page: 1, pageSize: 50, search: TAG, ongkirStatus })
  return rows.map((r) => r.instagramId).sort()
}

test("setup", async () => {
  const rows = (await sql`SELECT id FROM warehouses ORDER BY id`) as unknown as { id: number }[]
  WAREHOUSES = rows.map((r) => r.id)
  assert.ok(WAREHOUSES.length >= 2, "this test needs two warehouses to tell a half-priced customer apart")
  const [A, B] = WAREHOUSES

  await seed(PRICED, Object.fromEntries(WAREHOUSES.map((w) => [w, 20000])))
  await seed(NO_ROW, {})
  await seed(ZERO, Object.fromEntries(WAREHOUSES.map((w) => [w, 0])))
  await seed(HALF, { [A]: 18000, [B]: 0 })
  await seed(NO_ADDRESS, {}, null)
})

test("a customer with no rate row at all is found", async () => {
  assert.ok((await handles("unpriceable")).includes(NO_ROW), "a missing row bills at zero, same as a stored one")
})

test("a rate stored as zero is found too", async () => {
  // These are indistinguishable at the invoice, so they must be
  // indistinguishable here.
  assert.ok((await handles("unpriceable")).includes(ZERO))
})

test("one bad warehouse is enough, and she is listed once", async () => {
  const found = await handles("unpriceable")
  assert.equal(found.filter((h) => h === HALF).length, 1, "the NOT EXISTS must not fan her out per warehouse")
})

test("a fully priced customer is not in the answer", async () => {
  assert.ok(!(await handles("unpriceable")).includes(PRICED))
})

test("the actionable half excludes the ones with no address to price from", async () => {
  const all = await handles("unpriceable")
  const actionable = await handles("unpriceable_with_address")
  assert.ok(all.includes(NO_ADDRESS), "she is unpriceable, and the plain filter says so")
  assert.ok(!actionable.includes(NO_ADDRESS), "but there is no address, so nobody can fetch a rate")
  assert.ok(actionable.includes(NO_ROW), "this one has an address — somebody only has to look the rate up")
})

test("a quote alone is enough to price her", async () => {
  // Our own rate stays at zero; the courier's quote is what she is charged, and
  // the guard reads the same figure the invoice does.
  const [A] = WAREHOUSES
  await sql`
    UPDATE customer_warehouse_ongkir SET biteship_ongkir = 14000
     WHERE customer_id = (SELECT id FROM customers WHERE instagram_id = ${ZERO})
       AND warehouse_id = ${A}
  `
  const found = await handles("unpriceable")
  assert.ok(found.includes(ZERO), "still unpriced from the other warehouse")

  for (const w of WAREHOUSES.slice(1)) {
    await sql`
      UPDATE customer_warehouse_ongkir SET biteship_ongkir = 14000
       WHERE customer_id = (SELECT id FROM customers WHERE instagram_id = ${ZERO})
         AND warehouse_id = ${w}
    `
  }
  assert.ok(!(await handles("unpriceable")).includes(ZERO), "priced everywhere, so out of the net")
})

after(async () => {
  if (ids.length > 0) {
    await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ANY(${ids})`
    await sql`DELETE FROM customers WHERE id = ANY(${ids})`
  }
  await sql.end()
})
