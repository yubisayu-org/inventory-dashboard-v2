import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getCustomerProfile, updateCustomerProfile } from "./catalogue-profile"

const TAG = `proftest${process.hrtime.bigint()}`
let n = 0

let WAREHOUSE_ID = 0

async function makeCustomer(): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id, whatsapp, data_diri, kota, kecamatan, kode_pos, ongkos_kirim)
    VALUES (${`${TAG}_${n++}`}, '08123', 'Jl. Lama 1', 'KOTA BANDUNG', 'COBLONG', '40132', 25000)
    RETURNING id`
  const [w] = await sql<{ id: number }[]>`SELECT id FROM warehouses ORDER BY id LIMIT 1`
  WAREHOUSE_ID = w.id
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim, updated_at)
    VALUES (${row.id}, ${w.id}, 25000, NOW())`
  return row.id
}

after(async () => {
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("returns contact and address, never bank details", async () => {
  const id = await makeCustomer()
  await sql`UPDATE customers SET bank_account_number = '999888' WHERE id = ${id}`
  const p = await getCustomerProfile(id)
  assert.equal(p?.whatsapp, "08123")
  assert.equal(p?.kota, "KOTA BANDUNG")
  assert.ok(!("bankAccountNumber" in (p as object)), "bank details must not be in the shape at all")
  assert.ok(!("ongkosKirim" in (p as object)), "what they are charged is not theirs to read here")
})

test("saves contact and address changes", async () => {
  const id = await makeCustomer()
  await updateCustomerProfile(id, {
    name: "Shinta",
    whatsapp: "08999",
    dataDiri: "Jl. Baru 42",
    biteshipAreaId: "IDNP6IDNC148IDND843IDZ12250",
    biteshipAreaName: "Jakarta Selatan, Kebayoran Baru, 12250",
    kota: "JAKARTA SELATAN",
    kecamatan: "KEBAYORAN BARU",
    kodePos: "12250",
  })
  const p = await getCustomerProfile(id)
  assert.equal(p?.name, "Shinta")
  assert.equal(p?.dataDiri, "Jl. Baru 42")
  assert.equal(p?.kota, "JAKARTA SELATAN")
  assert.equal(p?.biteshipAreaId, "IDNP6IDNC148IDND843IDZ12250")
})

test("an unpriceable address keeps the old ongkir and flags for review", async () => {
  const id = await makeCustomer()
  await updateCustomerProfile(id, {
    name: "Shinta",
    whatsapp: "08999",
    dataDiri: "Jl. Baru 42",
    biteshipAreaId: "IDNXXX",
    biteshipAreaName: "Nowhere, Nowhere, 00000",
    kota: "NOWHERE AT ALL",
    kecamatan: "NOWHERE AT ALL",
    kodePos: "00000",
  })
  const [flag] = await sql<{ ongkir_needs_review: boolean }[]>`
    SELECT ongkir_needs_review FROM customers WHERE id = ${id}`
  assert.equal(flag.ongkir_needs_review, true, "staff must be able to find it")

  // customer_warehouse_ongkir is the real source of truth, not the legacy
  // customers.ongkos_kirim column. Never zero on a spelling — free shipping by
  // typo is the bug this exists to prevent.
  const [kept] = await sql<{ ongkos_kirim: number }[]>`
    SELECT ongkos_kirim FROM customer_warehouse_ongkir
     WHERE customer_id = ${id} AND warehouse_id = ${WAREHOUSE_ID}`
  assert.equal(kept.ongkos_kirim, 25000, "previous rate must survive")
})

test("a priceable address clears the review flag", async () => {
  const id = await makeCustomer()
  const [rate] = await sql<{ kab_kota_nama: string; kecamatan_nama: string }[]>`
    SELECT kab_kota_nama, kecamatan_nama FROM jne_rates LIMIT 1`
  await updateCustomerProfile(id, {
    name: "Shinta",
    whatsapp: "08999",
    dataDiri: "Jl. Baru 42",
    biteshipAreaId: "IDNOK",
    biteshipAreaName: "somewhere real",
    kota: rate.kab_kota_nama,
    kecamatan: rate.kecamatan_nama,
    kodePos: "12345",
  })
  const [row] = await sql<{ ongkir_needs_review: boolean }[]>`
    SELECT ongkir_needs_review FROM customers WHERE id = ${id}`
  assert.equal(row.ongkir_needs_review, false)
})
