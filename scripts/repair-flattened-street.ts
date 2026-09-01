/**
 * Take the street back out of a label that was stored as one.
 *
 * The catalogue's My details used to show `data_diri` — the composed LABEL —
 * in a box called "Address", and `<input type="text">` strips newlines, so
 * saving flattened the block into one run-on line. Some of those rows then
 * ended up in `jalan` too, which is the column the label is now built FROM.
 * A label stored as a street composes a label containing a label.
 *
 * This is not backfill-customer-street.ts and does not overlap with it. That
 * one fills an EMPTY `jalan` from a well-formed blob and skips any row that
 * already has a street. This one repairs rows whose street is already set and
 * is visibly a label — the case that one steps over.
 *
 * Recovery works even on a flattened blob, where the line-splitting parser in
 * lib/address.ts cannot help: her own kecamatan and kota say where the region
 * tail begins, so the street is what sits between the heading and that.
 *
 * DRY RUN by default. --commit writes. --relabel also recomposes data_diri for
 * the rows it repairs, which is safe here in a way it is not generally: these
 * labels are already damaged, so rebuilding one cannot make it worse.
 *
 *   npx tsx --env-file=.env.local scripts/repair-flattened-street.ts
 *   npx tsx --env-file=.env.local scripts/repair-flattened-street.ts --commit
 *   npx tsx --env-file=.env.local scripts/repair-flattened-street.ts --commit --relabel
 */

import sql from "@/lib/db-pool"
import { composeLabel, recoverStreet } from "@/lib/address"

const COMMIT = process.argv.includes("--commit")
const RELABEL = process.argv.includes("--relabel")
const VERBOSE = process.argv.includes("--verbose")

/** A street does not introduce itself. These headings only appear on labels. */
const LOOKS_LIKE_A_LABEL = /(^|\s)(nama|telepon|alamat\s*lengkap)\s*:/i

async function main() {
  const rows = (await sql`
    SELECT id, instagram_id, COALESCE(jalan, '') AS jalan,
           COALESCE(name, '') AS name, COALESCE(whatsapp, '') AS whatsapp,
           COALESCE(kota, '') AS kota, COALESCE(kecamatan, '') AS kecamatan,
           COALESCE(provinsi, '') AS provinsi, COALESCE(kode_pos, '') AS kode_pos,
           COALESCE(biteship_area_name, '') AS area_name,
           COALESCE(data_diri, '') AS data_diri
      FROM customers
     WHERE COALESCE(jalan, '') <> ''
  `) as unknown as {
    id: number; instagram_id: string; jalan: string; name: string; whatsapp: string
    kota: string; kecamatan: string; provinsi: string; kode_pos: string
    area_name: string; data_diri: string
  }[]

  const affected = rows.filter((r) => LOOKS_LIKE_A_LABEL.test(r.jalan))
  const writes: { id: number; jalan: string; dataDiri: string | null }[] = []
  const stuck: string[] = []

  for (const r of affected) {
    const jalan = recoverStreet(r.jalan, { kecamatan: r.kecamatan, kota: r.kota })
    if (!jalan) {
      stuck.push(`${r.instagram_id}: ${r.jalan.slice(0, 110)}`)
      continue
    }
    const dataDiri = RELABEL
      ? composeLabel({
          name: r.name, whatsapp: r.whatsapp, jalan,
          kecamatan: r.kecamatan, kota: r.kota, provinsi: r.provinsi,
          kodePos: r.kode_pos, areaName: r.area_name,
        })
      : null
    writes.push({ id: r.id, jalan, dataDiri })
  }

  console.log(`${rows.length} customers have a street stored.`)
  console.log(`   ${affected.length} of those hold a LABEL rather than a street`)
  console.log(`   ${writes.length} can be repaired, ${stuck.length} cannot be read`)
  if (RELABEL) console.log(`   --relabel: data_diri will be rebuilt for those ${writes.length}`)

  for (const w of (VERBOSE ? writes : writes.slice(0, 10))) {
    const before = affected.find((r) => r.id === w.id)!
    console.log(`\n   ${before.instagram_id}`)
    console.log(`     was: ${before.jalan.slice(0, 100)}`)
    console.log(`     now: ${w.jalan}`)
  }
  if (!VERBOSE && writes.length > 10) console.log(`\n   … and ${writes.length - 10} more (--verbose)`)

  if (stuck.length) {
    console.log(`\nCould not be read — left exactly as they are:`)
    for (const s of stuck) console.log(`   ${s}`)
  }

  if (!COMMIT) {
    console.log("\nDRY RUN — nothing written. Re-run with --commit.")
    await sql.end()
    return
  }

  // One statement per row rather than one big CASE: a few dozen rows at most,
  // and a failure part-way through leaves the rest readable instead of a
  // half-applied expression nobody can reconstruct.
  for (const w of writes) {
    if (w.dataDiri) {
      await sql`UPDATE customers SET jalan = ${w.jalan}, data_diri = ${w.dataDiri}, updated_at = NOW() WHERE id = ${w.id}`
    } else {
      await sql`UPDATE customers SET jalan = ${w.jalan}, updated_at = NOW() WHERE id = ${w.id}`
    }
  }
  console.log(`\nWrote ${writes.length} rows.`)
  await sql.end()
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err)
    await sql.end()
    process.exit(1)
  })
}
