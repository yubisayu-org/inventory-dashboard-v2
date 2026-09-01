import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"

/**
 * What a parcel is priced at: the courier's quote, or our own rate when there
 * is none.
 *
 * The rule lives in one generated column rather than at the sixteen places that
 * price a parcel, because sixteen copies is sixteen chances for one to drift --
 * and a site that priced differently from the rest would do it silently.
 *
 * The fallback is not a nicety. Fourteen rows have no quote and never will:
 * JNE refuses Sukaraja/Bogor, Paal Merah and Alam Barajo in Jambi, and
 * Kranggan/Mojokerto through Biteship, from either warehouse. Their figures
 * came from JNE's own website by hand, and live in `ongkos_kirim`.
 */

const TAG = `effong${process.hrtime.bigint()}`
let customerId = 0
/** Whatever this database numbers its warehouses — dev and production differ. */
let WH_A = 0
let WH_B = 0

async function rate(warehouseId: number) {
  const [r] = (await sql`
    SELECT ongkos_kirim, biteship_ongkir, effective_ongkir
      FROM customer_warehouse_ongkir
     WHERE customer_id = ${customerId} AND warehouse_id = ${warehouseId}
  `) as unknown as { ongkos_kirim: number; biteship_ongkir: number | null; effective_ongkir: number }[]
  return r
}

test("the quote is the price when there is one", async () => {
  const warehouses = (await sql`
    SELECT id FROM warehouses ORDER BY id LIMIT 2
  `) as unknown as { id: number }[]
  WH_A = warehouses[0].id
  WH_B = warehouses[1].id
  const [c] = (await sql`
    INSERT INTO customers (instagram_id) VALUES (${TAG}) RETURNING id
  `) as unknown as { id: number }[]
  customerId = c.id
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim, biteship_ongkir)
    VALUES (${customerId}, ${WH_A}, 22000, 14000)
  `
  assert.equal((await rate(WH_A)).effective_ongkir, 14000, "the courier's figure wins")
})

test("our own rate is the price when there is no quote", async () => {
  // Sukaraja, Paal Merah, Alam Barajo, Kranggan: JNE will not quote them at all.
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim, biteship_ongkir)
    VALUES (${customerId}, ${WH_B}, 10000, NULL)
  `
  assert.equal((await rate(WH_B)).effective_ongkir, 10000, "falls through, rather than pricing at nothing")
})

test("it follows a quote arriving later", async () => {
  await sql`
    UPDATE customer_warehouse_ongkir SET biteship_ongkir = 12000
     WHERE customer_id = ${customerId} AND warehouse_id = ${WH_B}
  `
  assert.equal((await rate(WH_B)).effective_ongkir, 12000, "generated, so it cannot go stale")
})

test("clearing a quote hands the price back to our rate", async () => {
  // This is what a move does: the area changes, the quote is dropped, and the
  // customer must keep pricing from the table until the next sweep.
  await sql`
    UPDATE customer_warehouse_ongkir SET biteship_ongkir = NULL
     WHERE customer_id = ${customerId} AND warehouse_id = ${WH_B}
  `
  assert.equal((await rate(WH_B)).effective_ongkir, 10000)
})

test("it cannot be written to directly", async () => {
  await assert.rejects(
    () => sql`
      UPDATE customer_warehouse_ongkir SET effective_ongkir = 999
       WHERE customer_id = ${customerId} AND warehouse_id = ${WH_A}
    `,
    /generated|cannot be used|column/i,
    "the rule is Postgres's to keep, not a caller's to override",
  )
})

test("a quote of zero is still a quote", async () => {
  // COALESCE takes the first NON-NULL, so an explicit zero is honoured rather
  // than falling through. Nothing writes one today, and if anything ever does
  // it means free shipping, which the guard should catch rather than the rate.
  await sql`
    UPDATE customer_warehouse_ongkir SET biteship_ongkir = 0
     WHERE customer_id = ${customerId} AND warehouse_id = ${WH_A}
  `
  assert.equal((await rate(WH_A)).effective_ongkir, 0)
})

after(async () => {
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM customers WHERE id = ${customerId}`
  await sql.end()
})
