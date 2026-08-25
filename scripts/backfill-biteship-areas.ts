/**
 * Map existing customer addresses to Biteship area ids.
 *
 * Searches per DISTINCT (kota, kecamatan) rather than per customer — many
 * customers share a district, and every search is a billable request. Sixty
 * districts across two hundred customers costs sixty requests, not two hundred.
 *
 * The postal code narrows the RESULTS, not the query: Biteship returns one area
 * per postal code within a district, so "Cimahi Utara" comes back three times
 * over. Without kode_pos every such district was three equally good answers and
 * went to a human — which is most districts, and is why so little of the
 * customer table was ever mapped. One search still covers every code in a
 * district; the codes only decide which of its results a given address means.
 *
 *   npx tsx --env-file-if-exists=.env.development.local scripts/backfill-biteship-areas.ts
 *   npx tsx --env-file-if-exists=.env.development.local scripts/backfill-biteship-areas.ts --apply
 *
 * Dry run by default: prints what it WOULD do and writes nothing. Only
 * unambiguous matches are ever applied — a wrong area is a wrong shipping
 * price on every future order for everyone in that district, and it would be
 * silent. Anything else is listed for a human to resolve.
 */

import sql from "@/lib/db-pool"
import { searchAreas, BiteshipNotConfiguredError } from "@/lib/biteship"
import { matchArea } from "@/lib/biteship-area-match"

const APPLY = process.argv.includes("--apply")

type Place = { kota: string; kecamatan: string; kodePos: string; customers: number }

async function distinctPlaces(): Promise<Place[]> {
  const rows = await sql<{ kota: string; kecamatan: string; kode_pos: string; customers: string }[]>`
    SELECT upper(trim(kota)) AS kota, upper(trim(kecamatan)) AS kecamatan,
           COALESCE(trim(kode_pos), '') AS kode_pos,
           count(*) AS customers
      FROM customers
     WHERE biteship_area_id IS NULL
       AND trim(kecamatan) <> ''
       AND trim(kota) <> ''
     GROUP BY 1, 2, 3
     ORDER BY count(*) DESC
  `
  return rows.map((r) => ({
    kota: r.kota,
    kecamatan: r.kecamatan,
    kodePos: r.kode_pos,
    customers: Number(r.customers),
  }))
}

async function main() {
  const places = await distinctPlaces()
  console.log(`${places.length} distinct places to map, covering ${places.reduce((n, p) => n + p.customers, 0)} customers.`)
  if (!places.length) {
    console.log("Nothing to do.")
    await sql.end()
    return
  }
  // The bill is one request per DISTRICT, not per place: a district with three
  // postal codes is three places sharing one answer. Counting places would
  // overstate it, and the number below is what actually gets spent.
  const queries = new Set(places.map((p) => `${p.kecamatan}, ${p.kota}`))
  console.log(
    `${queries.size} distinct districts to search — ` +
    `estimated cost IDR ${queries.size * 2} (one Maps request each).`,
  )
  console.log(APPLY ? "\nAPPLYING changes.\n" : "\nDRY RUN — nothing will be written. Re-run with --apply.\n")

  const matched: { place: Place; areaId: string; areaName: string }[] = []
  // District certain, exact code not. Good enough to price against, not good
  // enough to store as somebody's address — so these are reported and never
  // written.
  const approximate: { place: Place; areaId: string; areaName: string }[] = []
  const needsHuman: { place: Place; reason: string; candidates: string[] }[] = []

  // One district can appear several times over, once per postal code. The
  // search is the billable part and its answer is the same every time, so it is
  // made once and reused.
  const searched = new Map<string, Awaited<ReturnType<typeof searchAreas>>>()

  let done = 0
  for (const place of places) {
    // A thousand silent requests are indistinguishable from a hang.
    if (++done % 50 === 0 || done === places.length) {
      console.log(`   … ${done}/${places.length} places`)
    }
    // The district is the specific part; the city disambiguates it.
    const query = `${place.kecamatan}, ${place.kota}`
    let areas
    try {
      areas = searched.get(query) ?? await searchAreas(query)
      searched.set(query, areas)
    } catch (err) {
      if (err instanceof BiteshipNotConfiguredError) {
        console.error("BITESHIP_API_KEY is not set — cannot search. Nothing was changed.")
        await sql.end()
        process.exit(1)
      }
      needsHuman.push({ place, reason: "search failed", candidates: [] })
      continue
    }

    if (!areas.length) {
      needsHuman.push({ place, reason: "no results", candidates: [] })
      continue
    }

    const result = matchArea(areas, place)
    if (result.kind === "matched") {
      const row = { place, areaId: result.area.id, areaName: result.area.name }
      ;(result.approximate ? approximate : matched).push(row)
    } else {
      needsHuman.push({
        place,
        reason:
          result.kind === "none"
            ? "no confident match"
            : place.kodePos
              ? `${result.candidates.length} equally good matches, none with postal code ${place.kodePos}`
              : `${result.candidates.length} equally good matches and no postal code to separate them`,
        candidates: (result.kind === "ambiguous" ? result.candidates : areas)
          .slice(0, 5)
          .map((a) => a.name),
      })
    }
  }

  console.log(`\n${searched.size} searches made for ${places.length} places.`)
  console.log(`✓ ${matched.length} places matched confidently`)
  for (const m of matched) {
    console.log(`   ${m.place.kota} / ${m.place.kecamatan}${m.place.kodePos ? ` ${m.place.kodePos}` : ""}  ->  ${m.areaName}  (${m.place.customers} customers)`)
  }

  if (approximate.length) {
    const customers = approximate.reduce((n, a) => n + a.place.customers, 0)
    console.log(`\n~ ${approximate.length} places matched to their district only (${customers} customers)`)
    console.log("   Biteship carries different postal codes for these districts than our")
    console.log("   addresses use. A courier prices by district, so the rate is the same —")
    console.log("   but the area is not exactly theirs, so it is NOT written to the address.")
    for (const a of approximate) {
      console.log(`   ${a.place.kota} / ${a.place.kecamatan}${a.place.kodePos ? ` ${a.place.kodePos}` : ""}  ~>  ${a.areaName}  (${a.place.customers} customers)`)
    }
  }

  if (needsHuman.length) {
    console.log(`\n! ${needsHuman.length} places need a human decision`)
    for (const h of needsHuman) {
      console.log(`   ${h.place.kota} / ${h.place.kecamatan}${h.place.kodePos ? ` ${h.place.kodePos}` : ""} — ${h.reason} (${h.place.customers} customers)`)
      for (const c of h.candidates) console.log(`       candidate: ${c}`)
    }
    console.log("\n   These keep their current jne_rates pricing and are left unmapped.")
  }

  if (!APPLY) {
    console.log("\nDry run complete. Nothing written.")
    await sql.end()
    return
  }

  let updated = 0
  for (const m of matched) {
    const rows = await sql`
      UPDATE customers
         SET biteship_area_id = ${m.areaId}, biteship_area_name = ${m.areaName}, updated_at = NOW()
       WHERE biteship_area_id IS NULL
         AND upper(trim(kota)) = ${m.place.kota}
         AND upper(trim(kecamatan)) = ${m.place.kecamatan}
         AND COALESCE(trim(kode_pos), '') = ${m.place.kodePos}
      RETURNING id
    `
    updated += rows.length
  }
  console.log(`\nApplied: ${updated} customers mapped across ${matched.length} places.`)
  await sql.end()
}

main().catch(async (err) => {
  console.error("Backfill failed:", err)
  await sql.end()
  process.exit(1)
})
