/**
 * The rate rows that were never written, for warehouses nobody had shipped from.
 *
 * `customer_warehouse_ongkir` holds one row per customer PER WAREHOUSE, and a
 * missing row is not the same as a rate of zero -- except at the invoice, where
 * it is: the shipping line reads `COALESCE(..., cwo.ongkos_kirim, 0)`, and a
 * LEFT JOIN that finds nothing collapses to 0. A customer with no Depok row
 * ships free from Depok, silently.
 *
 * 163 mapped customers were in that state, 68 of them active, because they
 * registered through a path that only ever wrote the default warehouse. This
 * fills the gap from the same JNE table every other rate comes from.
 *
 * It only ADDS rows. An existing rate is never touched, however wrong it looks
 * -- a rate that disagrees with the table may be a discount somebody granted on
 * purpose, and only a person knows which.
 *
 * Districts are matched on letters alone, the way `resolveRatesDistrict` does
 * it: "JatiSampurna" finds "JATISAMPURNA", "Depok" finds "KOTA DEPOK". Where
 * that lands on two different prices, the row is left for a person, because a
 * rate is a price somebody pays.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-missing-warehouse-ongkir.ts
 *   npx tsx --env-file=.env.local scripts/backfill-missing-warehouse-ongkir.ts --commit
 *   npx tsx --env-file=.env.local scripts/backfill-missing-warehouse-ongkir.ts --warehouse DEPOK --commit
 */

import sql from "@/lib/db-pool"

const argv = process.argv.slice(2)
const COMMIT = argv.includes("--commit")
const onlyWarehouse = argv.includes("--warehouse")
  ? argv[argv.indexOf("--warehouse") + 1]?.toUpperCase()
  : null

const letters = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "")
const rupiah = (n: number) => `Rp ${new Intl.NumberFormat("id-ID").format(n)}`

type Gap = {
  customerId: number
  handle: string
  warehouseId: number
  warehouseCode: string
  kecamatan: string
  kota: string
  price: number | null
  /** Why no price, when there is none. */
  reason: string
}

async function main() {
  const warehouses = (await sql`
    SELECT id, code FROM warehouses ORDER BY id
  `) as unknown as { id: number; code: string }[]
  const targets = onlyWarehouse
    ? warehouses.filter((w) => w.code === onlyWarehouse)
    : warehouses
  if (!targets.length) {
    console.error(`No warehouse named ${onlyWarehouse}.`)
    await sql.end()
    process.exit(1)
  }

  // The whole rate table once, matched in memory: 14k rows against 3.5k
  // customers is a join Postgres does badly with a regexp on both sides.
  const rateRows = (await sql`
    SELECT origin_code, kab_kota_nama, kecamatan_nama, final_price FROM jne_rates
  `) as unknown as {
    origin_code: string; kab_kota_nama: string; kecamatan_nama: string; final_price: number
  }[]
  const byOrigin = new Map<string, { kab: string; kec: string; price: number }[]>()
  for (const r of rateRows) {
    const list = byOrigin.get(r.origin_code) ?? []
    list.push({ kab: letters(r.kab_kota_nama), kec: letters(r.kecamatan_nama), price: r.final_price })
    byOrigin.set(r.origin_code, list)
  }

  const gaps: Gap[] = []
  for (const w of targets) {
    const missing = (await sql`
      SELECT c.id, lower(replace(c.instagram_id, '@', '')) AS handle,
             COALESCE(c.kecamatan, '') AS kecamatan, COALESCE(c.kota, '') AS kota,
             COALESCE(c.biteship_area_name, '') AS area
        FROM customers c
       WHERE NOT EXISTS (
               SELECT 1 FROM customer_warehouse_ongkir cwo
                WHERE cwo.customer_id = c.id AND cwo.warehouse_id = ${w.id}
             )
       ORDER BY handle
    `) as unknown as {
      id: number; handle: string; kecamatan: string; kota: string; area: string
    }[]

    const rates = byOrigin.get(w.code) ?? []
    /** One price for this district, or null and the reason there isn't one. */
    const priceFor = (kecRaw: string, kotaRaw: string): { price: number | null; reason: string } => {
      const kec = letters(kecRaw)
      const kab = letters(kotaRaw)
      if (!kec || !kab) return { price: null, reason: "no district on the customer" }
      // Same rule as resolveRatesDistrict: one price, or it has not chosen.
      const hits = new Set(rates.filter((r) => r.kec === kec && r.kab.includes(kab)).map((r) => r.price))
      if (hits.size === 1) {
        const only = [...hits][0]
        return only > 0
          ? { price: only, reason: "" }
          : { price: null, reason: "the table has this district at 0 — an import gap" }
      }
      if (hits.size === 0) return { price: null, reason: "district not in the table for this origin" }
      return { price: null, reason: `${hits.size} different prices match — needs a person` }
    }

    for (const c of missing) {
      let { price, reason } = priceFor(c.kecamatan, c.kota)

      // Her own fields first, the area second. "Tebet / Jaksel" and "Medan
      // Area / Medan, sumatera Utara" are how people write their address, not
      // how JNE names a district -- but the Biteship area she is mapped to
      // spells both parts the way a table can be searched: "Tebet, Jakarta
      // Selatan, DKI Jakarta. 12810". Only consulted when her own fields
      // found nothing, so a district that already priced keeps its answer.
      if (price == null && c.area) {
        const [areaKec, areaKota] = c.area.split(",").map((s) => s.trim())
        if (areaKec && areaKota) {
          const viaArea = priceFor(areaKec, areaKota)
          if (viaArea.price != null) {
            price = viaArea.price
          } else if (reason === "district not in the table for this origin") {
            // The area's spelling is the better one to report against.
            reason = viaArea.reason
          }
        }
      }
      gaps.push({
        customerId: c.id, handle: c.handle, warehouseId: w.id, warehouseCode: w.code,
        kecamatan: c.kecamatan, kota: c.kota, price, reason,
      })
    }
  }

  const fillable = gaps.filter((g) => g.price != null)
  const stuck = gaps.filter((g) => g.price == null)

  for (const w of targets) {
    const mine = gaps.filter((g) => g.warehouseId === w.id)
    if (!mine.length) { console.log(`${w.code}: no missing rows.`); continue }
    console.log(`${w.code}: ${mine.length} customers with no rate row — ${mine.filter((g) => g.price != null).length} can be filled from the table.`)
  }

  if (fillable.length) {
    console.log(`\nWould write ${fillable.length} rows:`)
    for (const g of fillable.slice(0, 25)) {
      console.log(`   ${g.warehouseCode.padEnd(7)} ${g.handle.padEnd(22)} ${rupiah(g.price!).padStart(10)}   ${g.kecamatan} / ${g.kota}`)
    }
    if (fillable.length > 25) console.log(`   … ${fillable.length - 25} more`)
  }

  if (stuck.length) {
    console.log(`\n${stuck.length} left alone:`)
    const byReason = new Map<string, Gap[]>()
    for (const g of stuck) byReason.set(g.reason, [...(byReason.get(g.reason) ?? []), g])
    for (const [reason, list] of byReason) {
      console.log(`   ${list.length}× ${reason}`)
      for (const g of list.slice(0, 6)) {
        console.log(`      ${g.warehouseCode.padEnd(7)} ${g.handle.padEnd(22)} ${g.kecamatan || "(none)"} / ${g.kota || "(none)"}`)
      }
      if (list.length > 6) console.log(`      … ${list.length - 6} more`)
    }
  }

  if (!COMMIT) {
    console.log(`\nDry run. Nothing written. Add --commit to write the ${fillable.length} rows.`)
    await sql.end()
    return
  }

  let written = 0
  for (const g of fillable) {
    // ON CONFLICT DO NOTHING, not DO UPDATE: this script exists to fill an
    // absence. A row that appeared since the read is somebody else's answer.
    const rows = (await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim, updated_at)
      VALUES (${g.customerId}, ${g.warehouseId}, ${g.price!}, NOW())
      ON CONFLICT (customer_id, warehouse_id) DO NOTHING
      RETURNING customer_id
    `) as unknown as { customer_id: number }[]
    written += rows.length
  }
  console.log(`\nWritten: ${written} rows. No existing rate was changed.`)
  await sql.end()
}

main().catch(async (err) => {
  console.error("Backfill failed:", err)
  await sql.end()
  process.exit(1)
})
