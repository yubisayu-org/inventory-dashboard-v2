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
    jalan: "Jl. Baru 42",
    provinsi: "JAWA BARAT",
    biteshipAreaId: "IDNP6IDNC148IDND843IDZ12250",
    biteshipAreaName: "Jakarta Selatan, Kebayoran Baru, 12250",
    kota: "JAKARTA SELATAN",
    kecamatan: "KEBAYORAN BARU",
    kodePos: "12250",
  })
  const p = await getCustomerProfile(id)
  assert.equal(p?.name, "Shinta")
  assert.equal(p?.kota, "JAKARTA SELATAN")
  assert.equal(p?.biteshipAreaId, "IDNP6IDNC148IDND843IDZ12250")

  // Her street lands in the column the label is built from. It used not to be
  // written at all here: a customer who moved changed her city and district
  // while her street stayed where it was.
  assert.equal(p?.jalan, "Jl. Baru 42")
  assert.equal(p?.provinsi, "JAWA BARAT")

  // And the label is composed from those parts rather than stored as sent —
  // the same rule the staff form follows. Nothing a caller writes appears on
  // a parcel except through here.
  assert.match(p?.dataDiri ?? "", /^Nama: Shinta$/m)
  assert.match(p?.dataDiri ?? "", /^Telepon: 08999$/m)
  assert.match(p?.dataDiri ?? "", /^Jl\. Baru 42$/m)
  assert.match(p?.dataDiri ?? "", /12250/)
})

// The catalogue as it stands today sends only dataDiri, and what it sends is
// the whole composed LABEL. Storing that as a street would put a label inside
// a label — and the street column is the one the real label is built from, so
// the damage would outlive the caller.
test("a legacy save writes the string it sent and never touches the street", async () => {
  const id = await makeCustomer()
  await sql`UPDATE customers SET jalan = 'Jl. Asli 7' WHERE id = ${id}`
  const block = "Nama: Shinta\nTelepon: 08999\nAlamat Lengkap:\nJl. Asli 7\nCOBLONG, KOTA BANDUNG 40132"

  await updateCustomerProfile(id, {
    name: "Shinta",
    whatsapp: "08999",
    dataDiri: block,
    biteshipAreaId: null,
    biteshipAreaName: null,
    kota: "KOTA BANDUNG",
    kecamatan: "COBLONG",
    kodePos: "40132",
  })

  const p = await getCustomerProfile(id)
  assert.equal(p?.jalan, "Jl. Asli 7", "a label must never be stored as a street")
  assert.equal(p?.dataDiri, block, "the legacy string is written as it always was")
})

test("a save with no street to compose from leaves the stored label alone", async () => {
  const id = await makeCustomer()
  const before = (await getCustomerProfile(id))?.dataDiri
  await updateCustomerProfile(id, {
    name: "Shinta",
    whatsapp: "08999",
    // Nothing to build a label out of. Replacing a working hand-written one
    // with a version missing its street would be a downgrade, so it stands.
    jalan: "",
    provinsi: "",
    biteshipAreaId: null,
    biteshipAreaName: null,
    kota: "KOTA BANDUNG",
    kecamatan: "COBLONG",
    kodePos: "40132",
  })
  assert.equal((await getCustomerProfile(id))?.dataDiri, before)
})

test("an unpriceable address keeps the old ongkir and flags for review", async () => {
  const id = await makeCustomer()
  await updateCustomerProfile(id, {
    name: "Shinta",
    whatsapp: "08999",
    jalan: "Jl. Baru 42",
    provinsi: "JAWA BARAT",
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
  // The flag is raised when ANY warehouse cannot price the address, so this
  // test needs every warehouse to have a rate for its chosen destination —
  // not merely one row from jne_rates. It used to pass only because there was
  // a single warehouse and the table happened to return a matching row first;
  // adding a second warehouse in Settings broke it, which is the product
  // behaving correctly and the test assuming too much.
  const [origin] = await sql<{ code: string }[]>`SELECT code FROM warehouses ORDER BY id LIMIT 1`
  const [rate] = await sql<{ provinsi_nama: string; kab_kota_nama: string; kecamatan_nama: string }[]>`
    SELECT provinsi_nama, kab_kota_nama, kecamatan_nama FROM jne_rates
    WHERE upper(trim(origin_code)) = upper(trim(${origin.code})) AND final_price > 0
    LIMIT 1`
  assert.ok(rate, `no jne_rates row ships from ${origin.code} — this test cannot price anything`)

  // Lend a rate to any other warehouse for the length of this test, so the
  // assertion is about the flag's logic rather than about which warehouses
  // happen to exist in this database.
  const lent = await sql<{ origin_code: string }[]>`
    SELECT DISTINCT w.code AS origin_code FROM warehouses w
    WHERE NOT EXISTS (
      SELECT 1 FROM jne_rates j
      WHERE upper(trim(j.origin_code)) = upper(trim(w.code))
        AND upper(trim(j.kab_kota_nama)) = upper(trim(${rate.kab_kota_nama}))
        AND upper(trim(j.kecamatan_nama)) = upper(trim(${rate.kecamatan_nama}))
    )`
  for (const w of lent) {
    await sql`
      INSERT INTO jne_rates (provinsi_nama, kab_kota_nama, kecamatan_nama, final_price, origin_code)
      VALUES (${rate.provinsi_nama}, ${rate.kab_kota_nama}, ${rate.kecamatan_nama}, 25000, ${w.origin_code})`
  }
  await updateCustomerProfile(id, {
    name: "Shinta",
    whatsapp: "08999",
    jalan: "Jl. Baru 42",
    provinsi: "JAWA BARAT",
    biteshipAreaId: "IDNOK",
    biteshipAreaName: "somewhere real",
    kota: rate.kab_kota_nama,
    kecamatan: rate.kecamatan_nama,
    kodePos: "12345",
  })
  const [row] = await sql<{ ongkir_needs_review: boolean }[]>`
    SELECT ongkir_needs_review FROM customers WHERE id = ${id}`

  for (const w of lent) {
    await sql`DELETE FROM jne_rates
              WHERE origin_code = ${w.origin_code}
                AND kab_kota_nama = ${rate.kab_kota_nama}
                AND kecamatan_nama = ${rate.kecamatan_nama}`
  }

  assert.equal(row.ongkir_needs_review, false)
})

test("one unpriceable warehouse out of several still flags for review", async () => {
  // The dangerous case: a warehouse with no rate for the new address keeps the
  // OLD address's rate. Charging a moved customer their previous city's
  // shipping, unflagged, is worse than charging nothing.
  const id = await makeCustomer()
  const [extra] = await sql<{ id: number }[]>`
    INSERT INTO warehouses (code, name) VALUES (${`${TAG}_WH`}, 'Test WH') RETURNING id
  `
  try {
    const [rate] = await sql<{ kab_kota_nama: string; kecamatan_nama: string }[]>`
      SELECT kab_kota_nama, kecamatan_nama FROM jne_rates LIMIT 1`
    // Priceable from the real origin, not from the new one.
    await updateCustomerProfile(id, {
      name: "Shinta",
      whatsapp: "08999",
      jalan: "Jl. Baru 42",
      provinsi: "JAWA BARAT",
      biteshipAreaId: null,
      biteshipAreaName: null,
      kota: rate.kab_kota_nama,
      kecamatan: rate.kecamatan_nama,
      kodePos: "12345",
    })
    const [row] = await sql<{ ongkir_needs_review: boolean }[]>`
      SELECT ongkir_needs_review FROM customers WHERE id = ${id}`
    assert.equal(row.ongkir_needs_review, true, "a partial failure must be visible to staff")
  } finally {
    await sql`DELETE FROM warehouses WHERE id = ${extra.id}`
  }
})

