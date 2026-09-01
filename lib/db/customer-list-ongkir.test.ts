import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getCustomersPaginated } from "./customers"

/**
 * The customers list and the invoice must quote the same number.
 *
 * Sixteen pricing reads were moved onto `effective_ongkir` -- the courier's
 * quote, or our own rate where there is none. The list was not one of them,
 * because it does not charge anything, which is exactly how it came to print a
 * figure nobody would ever be billed. In production that was 120 rows across 89
 * customers, 29 of them showing Rp 0 against an invoice of up to Rp 69.000.
 *
 * Sorting and filtering are the worse half: they fail by omission. A customer
 * simply is not in the answer, and the answer looks complete.
 */

const TAG = `custongkir${process.hrtime.bigint()}`
const QUOTED = `${TAG}_quoted`     // a quote that overrides our rate
const UNQUOTED = `${TAG}_unquoted` // no quote, so our rate stands
const FREE = `${TAG}_free`         // our rate says nothing, the quote charges

let WH = 0
const ids: number[] = []

async function seed(handle: string, ourRate: number, quote: number | null) {
  const [c] = (await sql`
    INSERT INTO customers (instagram_id) VALUES (${handle}) RETURNING id
  `) as unknown as { id: number }[]
  ids.push(c.id)
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim, biteship_ongkir)
    VALUES (${c.id}, ${WH}, ${ourRate}, ${quote})
  `
  return c.id
}

async function page(opts: Parameters<typeof getCustomersPaginated>[0]) {
  return getCustomersPaginated(opts)
}

test("setup", async () => {
  const [w] = (await sql`SELECT id FROM warehouses ORDER BY id LIMIT 1`) as unknown as { id: number }[]
  WH = w.id
  await seed(QUOTED, 31000, 14000)
  await seed(UNQUOTED, 22000, null)
  await seed(FREE, 0, 69000)
})

test("the list prints what the invoice charges, not what we stored", async () => {
  const { rows } = await page({ page: 1, pageSize: 50, search: TAG })
  const byHandle = new Map(rows.map((r) => [r.instagramId, r]))

  assert.equal(byHandle.get(QUOTED)!.ongkir[WH], 14000, "the quote wins, as it does on the invoice")
  assert.equal(byHandle.get(FREE)!.ongkir[WH], 69000, "Rp 0 on the list was the sharpest case of all")
  assert.equal(byHandle.get(UNQUOTED)!.ongkir[WH], 22000, "with no quote, our own rate is what is charged")
})

test("the editor is still handed the rate it can actually write", async () => {
  const { rows } = await page({ page: 1, pageSize: 50, search: TAG })
  const byHandle = new Map(rows.map((r) => [r.instagramId, r]))

  // `effective_ongkir` is generated and refuses to be set, so the form edits
  // `ongkos_kirim`. Seeding it from the charged rate would copy a courier quote
  // into our own table the first time anybody pressed Save.
  assert.equal(byHandle.get(QUOTED)!.ongkirFallback[WH], 31000)
  assert.equal(byHandle.get(FREE)!.ongkirFallback[WH], 0)
  assert.equal(byHandle.get(UNQUOTED)!.ongkirFallback[WH], 22000)
})

test("filtering by ongkir no longer misses the customer it would bill", async () => {
  // Under the old reading FREE stored zero, so a "more than 50.000" filter
  // skipped her -- while her invoice charged 69.000.
  const { rows } = await page({
    page: 1,
    pageSize: 50,
    search: TAG,
    ongkirWarehouseId: WH,
    ongkirOp: "gt",
    ongkirValue: 50000,
  })
  assert.deepEqual(rows.map((r) => r.instagramId), [FREE])
})

test("filtering the other way does not sweep her back in", async () => {
  const { rows } = await page({
    page: 1,
    pageSize: 50,
    search: TAG,
    ongkirWarehouseId: WH,
    ongkirOp: "lt",
    ongkirValue: 20000,
  })
  assert.deepEqual(rows.map((r) => r.instagramId), [QUOTED], "14.000 is what she is charged, so she is the cheap one")
})

test("sorting puts them in the order the invoices would", async () => {
  const { rows } = await page({
    page: 1,
    pageSize: 50,
    search: TAG,
    sortKey: `ongkir_${WH}`,
    sortDir: "asc",
  })
  // Charged: 14.000 · 22.000 · 69.000. Stored: 31.000 · 22.000 · 0 — which
  // would have put the most expensive customer first.
  assert.deepEqual(rows.map((r) => r.instagramId), [QUOTED, UNQUOTED, FREE])
})

after(async () => {
  if (ids.length > 0) {
    await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ANY(${ids})`
    await sql`DELETE FROM customers WHERE id = ANY(${ids})`
  }
  await sql.end()
})
