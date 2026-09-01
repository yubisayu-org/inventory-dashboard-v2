import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getCustomersPaginated } from "./customers"

/**
 * Retiring `ekspedisi` without losing what it was actually used for.
 *
 * The column was the courier service once -- "JNE - REG" is still its single
 * most common value. But 3.027 of its 3.375 values are a copy of the district,
 * typed there before there was a kecamatan column to hold one. So the thing it
 * really did was let somebody search by area, and it was the ONLY searched
 * field that carried a district: kecamatan and kota were never in the search at
 * all.
 *
 * Dropping it from the search would therefore have quietly removed the ability
 * to find a customer by where she lives. The district is now searched where it
 * actually lives, along with the courier's own name for the area.
 */

const TAG = `areasearch${process.hrtime.bigint()}`
const BANDUNG = `${TAG}_bandung`
const BEKASI = `${TAG}_bekasi`
const ids: number[] = []

async function seed(
  handle: string,
  kecamatan: string,
  kota: string,
  areaName: string | null,
  ekspedisi: string,
) {
  const [c] = (await sql`
    INSERT INTO customers (instagram_id, kecamatan, kota, biteship_area_name, ekspedisi)
    VALUES (${handle}, ${kecamatan}, ${kota}, ${areaName}, ${ekspedisi})
    RETURNING id
  `) as unknown as { id: number }[]
  ids.push(c.id)
}

async function found(search: string) {
  const { rows } = await getCustomersPaginated({ page: 1, pageSize: 50, search })
  return rows.map((r) => r.instagramId).filter((h) => h.startsWith(TAG)).sort()
}

test("setup", async () => {
  await seed(BANDUNG, "COBLONG", "KOTA BANDUNG", "Coblong, Bandung, Jawa Barat. 40132", "JNE - REG")
  // The awkward one: her ekspedisi still holds the district, the way most rows
  // do. Nothing may depend on that any more.
  await seed(BEKASI, "JATISAMPURNA", "KOTA BEKASI", null, "Jatisampurna")
})

test("searching by kecamatan finds her", async () => {
  assert.deepEqual(await found("coblong"), [BANDUNG])
})

test("searching by kota finds her", async () => {
  assert.deepEqual(await found("kota bekasi"), [BEKASI])
})

test("searching by the courier's name for the area finds her", async () => {
  // The area name carries a postal code and a province the other fields do not.
  assert.deepEqual(await found("40132"), [BANDUNG])
})

test("a customer with no area is still findable by her district", async () => {
  // 3.559 customers and only some are mapped — searching must not depend on it.
  assert.deepEqual(await found("jatisampurna"), [BEKASI])
})

test("the retired column is no longer searched", async () => {
  // "JNE" survives in 315 rows and means nothing. Matching it would return a
  // sixth of the customer list for a query nobody intended as a filter.
  assert.deepEqual(await found("jne - reg"), [])
})

test("filtering the Area column reads the area, not the old field", async () => {
  const { rows } = await getCustomersPaginated({
    page: 1,
    pageSize: 50,
    search: TAG,
    biteshipArea: "coblong",
  })
  assert.deepEqual(rows.map((r) => r.instagramId), [BANDUNG])
})

after(async () => {
  if (ids.length > 0) await sql`DELETE FROM customers WHERE id = ANY(${ids})`
  await sql.end()
})
