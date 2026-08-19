/**
 * Map existing customer addresses to Biteship area ids.
 *
 * Searches per DISTINCT (kota, kecamatan) rather than per customer — many
 * customers share a district, and every search is a billable request. Sixty
 * districts across two hundred customers costs sixty requests, not two hundred.
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

const APPLY = process.argv.includes("--apply")

type Place = { kota: string; kecamatan: string; customers: number }

/** Strip the noise that differs between your data and Biteship's naming. */
function normalise(s: string): string {
  return s
    .toUpperCase()
    .replace(/\bKAB(UPATEN)?\.?\b/g, "")
    .replace(/\bKOTA\b/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

async function distinctPlaces(): Promise<Place[]> {
  const rows = await sql<{ kota: string; kecamatan: string; customers: string }[]>`
    SELECT upper(trim(kota)) AS kota, upper(trim(kecamatan)) AS kecamatan,
           count(*) AS customers
      FROM customers
     WHERE biteship_area_id IS NULL
       AND trim(kecamatan) <> ''
       AND trim(kota) <> ''
     GROUP BY 1, 2
     ORDER BY count(*) DESC
  `
  return rows.map((r) => ({
    kota: r.kota,
    kecamatan: r.kecamatan,
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
  console.log(`Estimated cost: IDR ${places.length * 2} (one Maps request each).`)
  console.log(APPLY ? "\nAPPLYING changes.\n" : "\nDRY RUN — nothing will be written. Re-run with --apply.\n")

  const matched: { place: Place; areaId: string; areaName: string }[] = []
  const needsHuman: { place: Place; reason: string; candidates: string[] }[] = []

  for (const place of places) {
    // The district is the specific part; the city disambiguates it.
    const query = `${place.kecamatan}, ${place.kota}`
    let areas
    try {
      areas = await searchAreas(query)
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

    // Confident only when exactly one candidate mentions BOTH the district and
    // the city. Two plausible matches is not a match.
    const wantKec = normalise(place.kecamatan)
    const wantKota = normalise(place.kota)
    const strong = areas.filter((a) => {
      const n = normalise(a.name)
      return n.includes(wantKec) && n.includes(wantKota)
    })

    if (strong.length === 1) {
      matched.push({ place, areaId: strong[0].id, areaName: strong[0].name })
    } else {
      needsHuman.push({
        place,
        reason: strong.length === 0 ? "no confident match" : `${strong.length} equally good matches`,
        candidates: areas.slice(0, 5).map((a) => a.name),
      })
    }
  }

  console.log(`✓ ${matched.length} places matched confidently`)
  for (const m of matched) {
    console.log(`   ${m.place.kota} / ${m.place.kecamatan}  ->  ${m.areaName}  (${m.place.customers} customers)`)
  }

  if (needsHuman.length) {
    console.log(`\n! ${needsHuman.length} places need a human decision`)
    for (const h of needsHuman) {
      console.log(`   ${h.place.kota} / ${h.place.kecamatan} — ${h.reason} (${h.place.customers} customers)`)
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
