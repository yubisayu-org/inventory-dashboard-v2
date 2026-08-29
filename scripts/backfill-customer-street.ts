/**
 * Take the street and the province back out of the address blob.
 *
 * `data_diri` is one free-text field that the shipping label prints, and for
 * most customers it was written by the registration form -- a heading or two,
 * "Alamat Lengkap:", the street, then the line naming her district. So the
 * street is recoverable for nearly everybody, and nobody has to retype 3.500
 * addresses.
 *
 * It writes `jalan` and `provinsi` and NOTHING else. The label text is left
 * exactly as it is: once a street is stored, the next save through the customer
 * editor composes it, and until then the parcel prints what it has always
 * printed. A backfill that also rewrote the labels would change what 3.500
 * parcels say on the strength of a parser nobody had checked yet.
 *
 * DRY RUN by default. --commit writes.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-customer-street.ts
 *   npx tsx --env-file=.env.local scripts/backfill-customer-street.ts --commit
 */

import sql from "@/lib/db-pool"
import { parseAddressBlob, composeLabel } from "@/lib/address"

const COMMIT = process.argv.includes("--commit")
/** Print every row it could not read, rather than the first handful. */
const VERBOSE = process.argv.includes("--verbose")

async function main() {
  // The columns arrive with migration 121. Without them the parse still runs
  // and still reports -- being able to see what a backfill WOULD recover, on
  // real data, is exactly what decides whether the migration is worth applying.
  const [hasColumns] = (await sql`
    SELECT 1 AS ok FROM information_schema.columns
     WHERE table_name = 'customers' AND column_name = 'jalan'
  `) as unknown as { ok: number }[]
  if (!hasColumns) {
    console.log("No jalan column here yet — migration 121 has not been applied.")
    console.log("Reporting what it would recover; --commit will refuse.\n")
  }

  const rows = (await sql.unsafe(`
    SELECT id, lower(replace(instagram_id, '@', '')) AS handle,
           COALESCE(data_diri, '') AS data_diri, COALESCE(name, '') AS name,
           COALESCE(whatsapp, '') AS whatsapp, COALESCE(kota, '') AS kota,
           COALESCE(kecamatan, '') AS kecamatan, COALESCE(kode_pos, '') AS kode_pos,
           COALESCE(biteship_area_name, '') AS area_name,
           ${hasColumns ? "COALESCE(jalan, '')" : "''"} AS jalan,
           ${hasColumns ? "COALESCE(provinsi, '')" : "''"} AS provinsi
      FROM customers
     ORDER BY id
  `)) as unknown as {
    id: number; handle: string; data_diri: string; name: string; whatsapp: string
    kota: string; kecamatan: string; kode_pos: string; jalan: string; provinsi: string
    area_name: string
  }[]

  let street = 0, province = 0, already = 0, blank = 0, unreadable = 0, sameLabel = 0
  const stuck: string[] = []
  const writes: { id: number; jalan: string; provinsi: string }[] = []

  for (const r of rows) {
    if (r.jalan.trim()) { already++; continue }
    if (!r.data_diri.trim()) { blank++; continue }

    const parsed = parseAddressBlob(r.data_diri, {
      kota: r.kota, kecamatan: r.kecamatan, kodePos: r.kode_pos,
    })
    if (!parsed.jalan) {
      unreadable++
      if (stuck.length < 10 || VERBOSE) stuck.push(`${r.handle}: ${r.data_diri.replace(/\n/g, " / ").slice(0, 100)}`)
      continue
    }

    street++
    if (parsed.provinsi) province++
    writes.push({ id: r.id, jalan: parsed.jalan, provinsi: parsed.provinsi ?? r.provinsi })

    // Would the label survive being made from the parts? Not written either
    // way -- but a parser that changes what a parcel says is worth knowing
    // about before the first save quietly does it.
    const rebuilt = composeLabel({
      name: r.name, whatsapp: r.whatsapp, jalan: parsed.jalan,
      kecamatan: r.kecamatan, kota: r.kota,
      provinsi: parsed.provinsi ?? r.provinsi, kodePos: r.kode_pos,
      areaName: r.area_name,
    })
    if (rebuilt.trim() === r.data_diri.trim()) sameLabel++
  }

  console.log(`${rows.length} customers.`)
  console.log(`   ${street} streets recovered, ${province} of them with a province`)
  console.log(`   ${sameLabel} of those rebuild the label they already print, character for character`)
  console.log(`   ${already} already have a street, ${blank} have no address text, ${unreadable} could not be read`)
  if (stuck.length) {
    console.log(`\nCould not be read${VERBOSE ? "" : " (first 10)"}:`)
    for (const s of stuck) console.log(`   ${s}`)
    console.log("   These keep the label they print today, until somebody fills in Jalan.")
  }

  if (!COMMIT) {
    console.log("\nDRY RUN — nothing written. Re-run with --commit.")
    await sql.end()
    return
  }
  if (!hasColumns) {
    console.error("\nRefusing to write: migration 121 is not applied here.")
    await sql.end()
    process.exit(1)
  }

  for (const w of writes) {
    await sql`
      UPDATE customers SET jalan = ${w.jalan}, provinsi = ${w.provinsi}, updated_at = NOW()
       WHERE id = ${w.id} AND COALESCE(jalan, '') = ''
    `
  }
  console.log(`\nWritten: ${writes.length} streets. No label text was changed.`)
  await sql.end()
}

main().catch(async (err) => {
  console.error("Backfill failed:", err)
  await sql.end()
  process.exit(1)
})
