import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { createWarehouse, updateWarehouse, getWarehouses } from "./catalog"

// Renaming a warehouse is only safe because jne_rates.origin_code is a foreign
// key onto warehouses(code) ON UPDATE CASCADE. Without that a rename strands
// every rate row and prices each parcel from there at zero, silently.

const TAG = `whtest${process.hrtime.bigint()}`.slice(0, 18).toUpperCase()
const CODE = `${TAG}A`
const RENAMED = `${TAG}B`
let id = 0

after(async () => {
  await sql`DELETE FROM jne_rates WHERE origin_code LIKE ${`${TAG}%`}`
  await sql`DELETE FROM warehouses WHERE code LIKE ${`${TAG}%`}`
  await sql.end()
})

test("a warehouse can be renamed, and its rates come with it", async () => {
  const made = await createWarehouse({ code: CODE, name: "Before" })
  id = made.id
  assert.equal(made.hasRates, false, "a brand new code has no rates")

  await sql`
    INSERT INTO jne_rates
      (origin_code, provinsi_nama, kab_kota_nama, kecamatan_nama,
       village_postal_codes, reg_duration, final_price)
    VALUES (${CODE}, 'Jawa Barat', ${`${TAG} Kota`}, 'Somewhere', '40521', '1-2', 25000)`

  const after = await updateWarehouse(id, { code: RENAMED, name: "After" })
  assert.equal(after.hasRates, true, "the cascade carried the rate row over")
  assert.equal(after.rateCount, 1)

  const [row] = await sql<{ origin_code: string }[]>`
    SELECT origin_code FROM jne_rates WHERE kab_kota_nama = ${`${TAG} Kota`}`
  assert.equal(row.origin_code, RENAMED, "no orphan left under the old code")

  const listed = (await getWarehouses()).find((w) => w.id === id)
  assert.equal(listed?.code, RENAMED)
  assert.equal(listed?.name, "After")
})

test("a rename cannot collide with another warehouse", async () => {
  const other = await createWarehouse({ code: `${TAG}C`, name: "Other" })
  await assert.rejects(() => updateWarehouse(id, { code: `${TAG}C`, name: "After" }), /already exists/)
  // And the collision changed nothing.
  const listed = (await getWarehouses()).find((w) => w.id === id)
  assert.equal(listed?.code, RENAMED)
  await sql`DELETE FROM warehouses WHERE id = ${other.id}`
})

test("keeping its own code is not a collision with itself", async () => {
  await updateWarehouse(id, { code: RENAMED, name: "Same code, new name" })
  const listed = (await getWarehouses()).find((w) => w.id === id)
  assert.equal(listed?.name, "Same code, new name")
})

test("a blank code or name is refused, and is_default is never touched", async () => {
  const before = (await getWarehouses()).find((w) => w.id === id)
  await assert.rejects(() => updateWarehouse(id, { code: "  ", name: "x" }), /Code is required/)
  await assert.rejects(() => updateWarehouse(id, { code: RENAMED, name: " " }), /Name is required/)
  const listed = (await getWarehouses()).find((w) => w.id === id)
  assert.equal(listed?.isDefault, before?.isDefault)
})

test("renaming a warehouse that is not there says so", async () => {
  await assert.rejects(() => updateWarehouse(999999, { code: `${TAG}Z`, name: "Ghost" }), /not found/)
})
