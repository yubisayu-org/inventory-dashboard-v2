/**
 * The customers who ship to one city and are priced for another.
 *
 * `scripts/backfill-customer-destination.ts` ran on 2 June 2026 and, for each
 * customer, walked their registration submissions oldest-first and stopped at
 * the first that resolved:
 *
 *     for (const s of arr) { const r = resolve(s); if (r) { canon = r; break } }
 *
 * Anyone who had registered TWICE — because they moved — got their FIRST ever
 * address written into `kecamatan`/`kota`/`kode_pos`, and their per-warehouse
 * rate computed from it. Nothing was ever mis-delivered: the shipping label
 * prints `data_diri`, which held the newer address all along. Only the price
 * was wrong, which is why it went unnoticed for three months.
 *
 * The registration CSV is gitignored and may be long gone, but the fix does not
 * need it. The label ends with the district line the form pasted --
 * "CIPUTAT, KOTA TANGERANG SELATAN 15414" -- and that is the address the parcel
 * actually went to. This reads it, resolves it against `jne_rates` the way
 * `resolveRatesDistrict` does (letters only, exactly one match or nothing), and
 * re-prices every warehouse from it.
 *
 * It also CLEARS the Biteship area and its quote, because both belong to the
 * city she left. Only a person can choose the new one, so the area is left empty
 * rather than guessed -- `COALESCE(biteship_ongkir, ongkos_kirim)` then falls
 * through to the freshly correct table rate.
 *
 * Rows where the label's last line reads like a street rather than a district
 * are reported and skipped: that is the parser guessing, not a customer moving.
 *
 *   npx tsx --env-file=.env.local scripts/fix-stale-district-from-label.ts
 *   npx tsx --env-file=.env.local scripts/fix-stale-district-from-label.ts --commit
 *   npx tsx --env-file=.env.local scripts/fix-stale-district-from-label.ts --include-renamed
 */

import sql from "@/lib/db-pool"

const argv = process.argv.slice(2)
const COMMIT = argv.includes("--commit")
/** Also take same-city district renames (Buahbatu -> Bandung Kidul), not only moves. */
const INCLUDE_RENAMED = argv.includes("--include-renamed")

const letters = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "")
const rupiah = (n: number | null) => (n == null ? "none" : `Rp ${new Intl.NumberFormat("id-ID").format(n)}`)

/** A last line that names a street is the parser guessing, not a district. */
const READS_LIKE_A_STREET =
  /(^|\s)(jl\.?|jalan|blok|no\.?\s*\d|rt[\s.]|rw[\s.]|perum|komplek|kompleks|apart|gang|gg\.)/i

type Candidate = {
  id: number
  handle: string
  orders: number
  /** What is stored, and prices her today. */
  kec: string; kota: string; pos: string
  /** What the label says, and where her parcels actually go. */
  lkec: string; lkota: string; lpos: string
  area: string
  sameCity: boolean
}

async function main() {
  const warehouses = (await sql`
    SELECT id, code FROM warehouses ORDER BY id
  `) as unknown as { id: number; code: string }[]

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
  /** The canonical jne_rates spelling for a district, or null if it has not chosen. */
  const canonical = (kec: string, kota: string) => {
    const k = letters(kec), c = letters(kota)
    if (!k || !c) return null
    const hits = rateRows.filter(
      (r) => letters(r.kecamatan_nama) === k && letters(r.kab_kota_nama).includes(c),
    )
    const names = new Set(hits.map((r) => `${r.kecamatan_nama.trim()}|${r.kab_kota_nama.trim()}`))
    if (names.size !== 1) return null
    const [kecName, kotaName] = [...names][0].split("|")
    return { kecamatan: kecName, kota: kotaName }
  }
  const priceFor = (origin: string, kec: string, kota: string) => {
    const k = letters(kec), c = letters(kota)
    const hits = new Set(
      (byOrigin.get(origin) ?? []).filter((r) => r.kec === k && r.kab.includes(c)).map((r) => r.price),
    )
    return hits.size === 1 ? [...hits][0] : null
  }

  const rows = (await sql`
    SELECT c.id, lower(replace(c.instagram_id, '@', '')) AS handle,
           COALESCE(c.kecamatan, '') AS kec, COALESCE(c.kota, '') AS kota,
           COALESCE(c.kode_pos, '') AS pos, COALESCE(c.data_diri, '') AS dd,
           COALESCE(c.biteship_area_name, '') AS area,
           (SELECT count(*) FROM orders o
             WHERE lower(replace(o.customer, '@', '')) = lower(replace(c.instagram_id, '@', ''))
               AND o.unit > 0)::int AS orders
      FROM customers c
     WHERE COALESCE(c.data_diri, '') <> '' AND COALESCE(c.kecamatan, '') <> ''
  `) as unknown as {
    id: number; handle: string; kec: string; kota: string; pos: string
    dd: string; area: string; orders: number
  }[]

  const candidates: Candidate[] = []
  const unsure: { handle: string; last: string }[] = []

  for (const r of rows) {
    const lines = r.dd.split("\n").map((s) => s.trim()).filter(Boolean)
    const last = lines[lines.length - 1] ?? ""
    const m = last.match(/^([^,]+),\s*(.+?)\s*(\d{5})?$/)
    if (!m) continue
    const [, lkec, lkotaRaw, lpos] = m
    if (/^(email|telepon|nama)/i.test(lkec)) continue
    const lkota = lkotaRaw.replace(/\s*\d{5}\s*$/, "")

    const kecSame = letters(lkec) === letters(r.kec) ||
      letters(lkec).includes(letters(r.kec)) || letters(r.kec).includes(letters(lkec))
    const kotaSame = letters(lkota).includes(letters(r.kota)) || letters(r.kota).includes(letters(lkota))
    if (kecSame && kotaSame) continue
    if (kecSame) continue // only the city string is written differently

    if (READS_LIKE_A_STREET.test(last)) { unsure.push({ handle: r.handle, last }); continue }
    if (kotaSame && !INCLUDE_RENAMED) continue

    candidates.push({
      id: r.id, handle: r.handle, orders: r.orders,
      kec: r.kec, kota: r.kota, pos: r.pos,
      lkec, lkota, lpos: lpos ?? "", area: r.area, sameCity: kotaSame,
    })
  }

  console.log(`${candidates.length} customers where the label names a district the columns do not`)
  if (!INCLUDE_RENAMED) console.log(`(same-city renames excluded — pass --include-renamed for those)`)

  let ready = 0
  const stuck: { c: Candidate; why: string }[] = []
  const plan: { c: Candidate; canon: { kecamatan: string; kota: string }; rates: Map<number, { from: number | null; to: number }>; unpriced: string[] }[] = []

  for (const c of candidates) {
    const canon = canonical(c.lkec, c.lkota)
    if (!canon) { stuck.push({ c, why: "the label's district is not in jne_rates, or matches more than one" }); continue }

    // Per warehouse, not all-or-nothing. A district the table cannot price from
    // ONE origin used to block the address correction entirely -- which left
    // `ayu_purnama.sari` priced to Karanganyar while shipping to Palembang,
    // because Depok has no rate for Seberang Ulu I. The address is right or it
    // is not; a gap in one origin's price list has no bearing on that. The
    // warehouse that cannot be priced keeps whatever it had.
    const rates = new Map<number, { from: number | null; to: number }>()
    const unpriced: string[] = []
    for (const w of warehouses) {
      const to = priceFor(w.code, canon.kecamatan, canon.kota)
      const [cur] = (await sql`
        SELECT ongkos_kirim::int AS p FROM customer_warehouse_ongkir
         WHERE customer_id = ${c.id} AND warehouse_id = ${w.id}
      `) as unknown as { p: number }[]
      if (to == null || to === 0) { unpriced.push(w.code); continue }
      rates.set(w.id, { from: cur?.p ?? null, to })
    }
    if (!rates.size) {
      stuck.push({ c, why: `no origin can price ${canon.kecamatan}, ${canon.kota}` })
      continue
    }
    ready++
    plan.push({ c, canon, rates, unpriced })
  }

  console.log(`\n${ready} can be re-priced from the label:\n`)
  for (const { c, canon, rates, unpriced } of plan.sort((a, b) => b.c.orders - a.c.orders)) {
    const moves = warehouses
      .map((w) => {
        const r = rates.get(w.id)
        if (!r) return `${w.code} not priced`
        const same = r.from === r.to
        return `${w.code} ${rupiah(r.from)}${same ? " (unchanged)" : ` → ${rupiah(r.to)}`}`
      })
      .join("   ")
    console.log(`   ${c.handle.padEnd(20)} ${String(c.orders).padStart(3)} orders`)
    console.log(`       priced as ${c.kec}, ${c.kota} ${c.pos}`)
    console.log(`       ships to  ${canon.kecamatan}, ${canon.kota} ${c.lpos}`)
    console.log(`       ${moves}`)
    if (unpriced.length) console.log(`       ${unpriced.join(", ")} has no price for that district — left as it was`)
    if (c.area) console.log(`       clears the area: ${c.area}`)
  }

  if (stuck.length) {
    console.log(`\n${stuck.length} need a person:`)
    for (const { c, why } of stuck) {
      console.log(`   ${c.handle.padEnd(20)} ${c.lkec}, ${c.lkota} — ${why}`)
    }
  }
  if (unsure.length) {
    console.log(`\n${unsure.length} skipped — the label's last line reads like a street, not a district:`)
    for (const u of unsure) console.log(`   ${u.handle.padEnd(20)} ${u.last.slice(0, 80)}`)
  }

  if (!COMMIT) {
    console.log(`\nDry run. Nothing written. Add --commit to apply the ${ready} above.`)
    await sql.end()
    return
  }

  let written = 0
  for (const { c, canon, rates } of plan) {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE customers
           SET kecamatan = ${canon.kecamatan},
               kota      = ${canon.kota},
               kode_pos  = ${c.lpos || c.pos},
               -- Both belong to the city she left. Only a person can choose the
               -- new area, so leave it empty rather than guess: the price then
               -- falls through to the table rate written just below.
               biteship_area_id   = NULL,
               biteship_area_name = NULL,
               updated_at = NOW()
         WHERE id = ${c.id}
      `
      for (const [warehouseId, r] of rates) {
        await tx`
          INSERT INTO customer_warehouse_ongkir
                 (customer_id, warehouse_id, ongkos_kirim, biteship_ongkir, biteship_quoted_at, updated_at)
          VALUES (${c.id}, ${warehouseId}, ${r.to}, NULL, NULL, NOW())
          ON CONFLICT (customer_id, warehouse_id)
          DO UPDATE SET ongkos_kirim = EXCLUDED.ongkos_kirim,
                        biteship_ongkir = NULL,
                        biteship_quoted_at = NULL,
                        updated_at = NOW()
        `
      }
    })
    written++
  }
  console.log(`\nWritten: ${written} customers re-priced, their stale area and quote cleared.`)
  console.log(`Re-pick each area in the dashboard, or let the next sweep quote them.`)
  await sql.end()
}

main().catch(async (err) => {
  console.error("Failed:", err)
  await sql.end()
  process.exit(1)
})
