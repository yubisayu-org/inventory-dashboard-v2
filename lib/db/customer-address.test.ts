import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { updateCustomer } from "./customers"

const TAG = `addrtest${process.hrtime.bigint()}`
let n = 0

async function makeCustomer(): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id, whatsapp, data_diri, kota, kecamatan, kode_pos,
                           biteship_area_id, biteship_area_name)
    VALUES (${`${TAG}_${n++}`}, '08123', 'Jl. Lama 1', 'KOTA BANDUNG', 'COBLONG', '40132',
            'IDZ40132', 'Coblong, Bandung, Jawa Barat. 40132')
    RETURNING id`
  return row.id
}

const base = {
  name: "Someone",
  whatsapp: "08123",
  dataDiri: "Jl. Lama 1",
  ekspedisi: "JNE - REG",
  ongkir: {},
  bankName: "",
  bankAccountNumber: "",
  bankAccountHolder: "",
}

async function read(id: number) {
  const [r] = await sql<{ kota: string; kecamatan: string; kode_pos: string; area: string | null }[]>`
    SELECT kota, kecamatan, kode_pos, biteship_area_id AS area FROM customers WHERE id = ${id}`
  return r
}

after(async () => {
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("a save from the address screen writes her district and its area", async () => {
  const id = await makeCustomer()
  const handle = `${TAG}_${n - 1}`
  await updateCustomer(id, {
    ...base,
    instagramId: handle,
    kota: "KOTA SURAKARTA",
    kecamatan: "PASAR KLIWON",
    kodePos: "57113",
    biteshipAreaId: "IDZ57113",
    biteshipAreaName: "Pasar Kliwon, Surakarta, Jawa Tengah. 57113",
  })
  const r = await read(id)
  assert.equal(r.kecamatan, "PASAR KLIWON")
  assert.equal(r.kode_pos, "57113")
  assert.equal(r.area, "IDZ57113")
})

test("a save from a screen that never asked leaves the address alone", async () => {
  // The bank-details save and the add form send no address at all. Folding
  // these columns into the same UPDATE would blank what the catalogue set
  // every time somebody corrected an account number.
  const id = await makeCustomer()
  const handle = `${TAG}_${n - 1}`
  await updateCustomer(id, { ...base, instagramId: handle, bankName: "BCA" })
  const r = await read(id)
  assert.equal(r.kota, "KOTA BANDUNG")
  assert.equal(r.kecamatan, "COBLONG")
  assert.equal(r.area, "IDZ40132")
})

test("changing the address without naming an area clears the old one", async () => {
  // The stored area belonged to the old address. Keeping it would book her
  // parcels to a place she has moved away from — worse than having none.
  const id = await makeCustomer()
  const handle = `${TAG}_${n - 1}`
  await updateCustomer(id, {
    ...base,
    instagramId: handle,
    kota: "KOTA BEKASI",
    kecamatan: "PONDOK GEDE",
    kodePos: "17411",
  })
  const r = await read(id)
  assert.equal(r.kecamatan, "PONDOK GEDE")
  assert.equal(r.area, null)
})
