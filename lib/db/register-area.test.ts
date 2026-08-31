import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { registerCustomer, updateCustomer } from "./customers"

/**
 * A customer who moves must not keep the area she left.
 *
 * On 30 Aug 2026, 84 customers were priced to cities they had moved away from,
 * and seven more kept a quote for the old town after their area was corrected
 * by hand. Both faults were invisible while the invoice priced from
 * `ongkos_kirim`; both become permanent mispricing the moment it prices from
 * `COALESCE(biteship_ongkir, ongkos_kirim)`. These tests are the guard.
 */

const TAG = `regarea${process.hrtime.bigint()}`
let n = 0

const base = {
  name: "Someone",
  whatsapp: "08123",
  dataDiri: "Jl. Lama 1",
  ekspedisi: "JNE - REG",
}

async function read(handle: string) {
  const [r] = (await sql`
    SELECT c.id, c.kota, c.kecamatan, c.kode_pos, c.jalan,
           c.biteship_area_id AS area, c.biteship_area_name AS area_name
      FROM customers c WHERE lower(replace(c.instagram_id, '@', '')) = ${handle}
  `) as unknown as {
    id: number; kota: string; kecamatan: string; kode_pos: string
    jalan: string; area: string | null; area_name: string | null
  }[]
  return r
}

async function quotes(id: number) {
  return (await sql`
    SELECT warehouse_id, ongkos_kirim::int AS ours, biteship_ongkir::int AS quote
      FROM customer_warehouse_ongkir WHERE customer_id = ${id} ORDER BY warehouse_id
  `) as unknown as { warehouse_id: number; ours: number; quote: number | null }[]
}

test("registering stores the area the form chose", async () => {
  const handle = `${TAG}_${n++}`
  await registerCustomer({
    ...base, instagramId: handle,
    kota: "KOTA BANDUNG", kecamatan: "COBLONG", kodePos: "40132",
    jalan: "Jl. Dago 1", provinsi: "JAWA BARAT",
    biteshipAreaId: "IDNP9IDNC1IDND1IDZ40132",
    biteshipAreaName: "Coblong, Bandung, Jawa Barat. 40132",
  })
  const c = await read(handle)
  assert.equal(c.area, "IDNP9IDNC1IDND1IDZ40132")
  assert.equal(c.area_name, "Coblong, Bandung, Jawa Barat. 40132")
})

test("re-registering from a new city replaces the area and drops the old quote", async () => {
  const handle = `${TAG}_${n++}`
  await registerCustomer({
    ...base, instagramId: handle,
    kota: "KOTA BANDUNG", kecamatan: "COBLONG", kodePos: "40132",
    biteshipAreaId: "IDZ40132", biteshipAreaName: "Coblong, Bandung. 40132",
  })
  const before = await read(handle)
  // A quote she was carrying for Bandung.
  await sql`
    UPDATE customer_warehouse_ongkir
       SET biteship_ongkir = 8000, biteship_quoted_at = NOW()
     WHERE customer_id = ${before.id}
  `

  await registerCustomer({
    ...base, instagramId: handle,
    kota: "KAB. BADUNG", kecamatan: "KUTA SELATAN", kodePos: "80361",
    biteshipAreaId: "IDZ80361", biteshipAreaName: "Kuta Selatan, Badung, Bali. 80361",
  })

  const after = await read(handle)
  assert.equal(after.kota, "KAB. BADUNG")
  assert.equal(after.kecamatan, "KUTA SELATAN")
  assert.equal(after.area, "IDZ80361", "the area must follow her")
  for (const q of await quotes(after.id)) {
    assert.equal(q.quote, null, "Bandung's quote must not survive a move to Bali")
  }
})

test("a move with NO area found still clears the old one", async () => {
  // Biteship carries no area for about 3% of districts. Keeping the old area
  // would price her to the old town; keeping none prices her from jne_rates,
  // which is correct.
  const handle = `${TAG}_${n++}`
  await registerCustomer({
    ...base, instagramId: handle,
    kota: "KOTA BANDUNG", kecamatan: "COBLONG", kodePos: "40132",
    biteshipAreaId: "IDZ40132", biteshipAreaName: "Coblong, Bandung. 40132",
  })
  await registerCustomer({
    ...base, instagramId: handle,
    kota: "KAB. BADUNG", kecamatan: "KUTA SELATAN", kodePos: "80361",
    biteshipAreaId: null, biteshipAreaName: null,
  })
  const after = await read(handle)
  assert.equal(after.area, null)
})

test("re-registering from the SAME address keeps the area", async () => {
  // She re-registers to correct a phone number, and the form could not reach
  // Biteship. Nothing about her address changed, so the area she already has
  // is still the right one -- throwing it away would cost a billed lookup to
  // recover something we already knew.
  const handle = `${TAG}_${n++}`
  await registerCustomer({
    ...base, instagramId: handle,
    kota: "KOTA BANDUNG", kecamatan: "COBLONG", kodePos: "40132",
    biteshipAreaId: "IDZ40132", biteshipAreaName: "Coblong, Bandung. 40132",
  })
  await registerCustomer({
    ...base, instagramId: handle, whatsapp: "08999",
    kota: "KOTA BANDUNG", kecamatan: "COBLONG", kodePos: "40132",
  })
  const after = await read(handle)
  assert.equal(after.area, "IDZ40132")
})

test("editing a customer's area in the dashboard drops the stale quote", async () => {
  const handle = `${TAG}_${n++}`
  await registerCustomer({
    ...base, instagramId: handle,
    kota: "KOTA BANDUNG", kecamatan: "COBLONG", kodePos: "40132",
    biteshipAreaId: "IDZ40132", biteshipAreaName: "Coblong, Bandung. 40132",
  })
  const c = await read(handle)
  await sql`
    UPDATE customer_warehouse_ongkir
       SET biteship_ongkir = 8000, biteship_quoted_at = NOW()
     WHERE customer_id = ${c.id}
  `

  await updateCustomer(c.id, {
    instagramId: handle, name: "Someone", whatsapp: "08123", dataDiri: "x",
    ekspedisi: "JNE - REG", ongkir: {}, bankName: "", bankAccountNumber: "",
    bankAccountHolder: "",
    kota: "KOTA TANGERANG SELATAN", kecamatan: "PONDOK AREN", kodePos: "15227",
    jalan: "Jl. Baru 2", provinsi: "BANTEN",
    biteshipAreaId: "IDZ15227", biteshipAreaName: "Pondok Aren, Tangsel. 15227",
  })

  for (const q of await quotes(c.id)) {
    assert.equal(q.quote, null, "the quote belonged to the area that was replaced")
  }
})

test("editing bank details does not throw away a quote", async () => {
  // The clearing rule keys on the AREA changing, not on the update happening.
  const handle = `${TAG}_${n++}`
  await registerCustomer({
    ...base, instagramId: handle,
    kota: "KOTA BANDUNG", kecamatan: "COBLONG", kodePos: "40132",
    biteshipAreaId: "IDZ40132", biteshipAreaName: "Coblong, Bandung. 40132",
  })
  const c = await read(handle)
  await sql`
    UPDATE customer_warehouse_ongkir
       SET biteship_ongkir = 8000, biteship_quoted_at = NOW()
     WHERE customer_id = ${c.id}
  `
  await updateCustomer(c.id, {
    instagramId: handle, name: "Someone", whatsapp: "08123", dataDiri: "x",
    ekspedisi: "JNE - REG", ongkir: {}, bankName: "BCA",
    bankAccountNumber: "123", bankAccountHolder: "Someone",
  })
  const rows = await quotes(c.id)
  assert.ok(rows.some((q) => q.quote === 8000), "a bank edit must leave the quote alone")
})

after(async () => {
  await sql`
    DELETE FROM customer_warehouse_ongkir
     WHERE customer_id IN (SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})
  `
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})
