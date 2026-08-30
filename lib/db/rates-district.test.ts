import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { resolveRatesDistrict } from "./customers"

after(async () => { await sql.end() })

test("the courier's spelling finds the rates table's spelling", async () => {
  // Biteship says "Limo, Depok"; jne_rates has "LIMO, KOTA DEPOK". None of the
  // 663 districts our customers live in exist under Biteship's own words, so
  // this translation is the difference between an address that prices and one
  // that does not.
  const r = await resolveRatesDistrict("Limo", "Depok")
  assert.equal(r?.kota.toUpperCase(), "KOTA DEPOK")
  assert.equal(r?.kecamatan.toUpperCase(), "LIMO")
})

test("a missing space is not a different district here either", async () => {
  const r = await resolveRatesDistrict("Jati Sampurna", "Bekasi")
  assert.equal(r?.kecamatan.toUpperCase(), "JATISAMPURNA")
})

test("a district the table has never heard of resolves to nothing", async () => {
  assert.equal(await resolveRatesDistrict("Nowhere At All", "Atlantis"), null)
  assert.equal(await resolveRatesDistrict("", "Depok"), null)
})
