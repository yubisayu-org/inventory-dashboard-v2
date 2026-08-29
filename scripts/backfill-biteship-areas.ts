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
 *   npx tsx --env-file-if-exists=.env.development.local scripts/backfill-biteship-areas.ts --rates
 *   npx tsx --env-file-if-exists=.env.development.local scripts/backfill-biteship-areas.ts --accept-district --apply
 *
 * Dry run by default: prints what it WOULD do and writes nothing. Only
 * unambiguous matches are ever applied — a wrong area is a wrong shipping
 * price on every future order for everyone in that district, and it would be
 * silent. Anything else is listed for a human to resolve.
 */

import sql from "@/lib/db-pool"
import { searchAreas, courierRates, BiteshipNotConfiguredError, type BiteshipArea } from "@/lib/biteship"
import { matchArea, matchByPostal } from "@/lib/biteship-area-match"

const APPLY = process.argv.includes("--apply")
/**
 * Also ask what a courier would charge to each area it resolved, and print it
 * beside what the invoice charges today. Answers the only question that makes
 * "the district is right, the postal code is not" a decision rather than a
 * detail: whether the two prices differ at all.
 */
const RATES = process.argv.includes("--rates")
/**
 * Also write the district-only matches -- the ones where Biteship carries a
 * different set of postal codes for a district than our addresses use.
 *
 * Not the default, because "the right district" and "the right area" are not
 * the same claim. It became a reasonable claim only once the prices were
 * checked: 108 of these 111 districts quote exactly what the invoice already
 * charges, so storing the district's area moves no money.
 */
const ACCEPT_DISTRICT = process.argv.includes("--accept-district")

/**
 * Places held back from the district-only write.
 *
 * Was three, on 29 Aug: Pasar Kliwon, Pagedangan and Johan Pahlawan, whose
 * quoted price disagrees with what we charge. The owner released them on
 * 30 Aug -- mapping an area and correcting a rate are separate jobs, and
 * holding the first hostage to the second only kept them invisible. The rate
 * question travels with every other differing rate instead, on the quotes now
 * stored beside our own.
 *
 * Kept as a mechanism rather than deleted: the next audit will find its own
 * reasons to hold something back.
 */
const HELD: [kota: string, kecamatan: string, kodePos: string][] = []
const isHeld = (p: Place) =>
  HELD.some(([kota, kec, pos]) => p.kota === kota && p.kecamatan === kec && p.kodePos === pos)

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

/**
 * The per-kilo rate the invoice charges today, by place.
 *
 * `customer_warehouse_ongkir.ongkos_kirim` times the parcel's kilos is the
 * shipping line on every invoice, so this is the number a Biteship quote has
 * to be compared against. A place can hold two customers on different rates --
 * they were set by hand over a year -- so both ends are kept.
 */
async function storedRates() {
  const rows = (await sql`
    SELECT upper(trim(c.kota)) AS kota, upper(trim(c.kecamatan)) AS kecamatan,
           COALESCE(trim(c.kode_pos), '') AS kode_pos,
           min(cwo.ongkos_kirim)::int AS lo, max(cwo.ongkos_kirim)::int AS hi
      FROM customers c
      JOIN customer_warehouse_ongkir cwo
        ON cwo.customer_id = c.id AND cwo.warehouse_id = 1
     WHERE c.biteship_area_id IS NULL AND trim(c.kecamatan) <> '' AND trim(c.kota) <> ''
     GROUP BY 1, 2, 3
  `) as unknown as { kota: string; kecamatan: string; kode_pos: string; lo: number; hi: number }[]
  return new Map(rows.map((r) => [`${r.kota}|${r.kecamatan}|${r.kode_pos}`, r]))
}

const rupiah = (n: number) => `Rp ${new Intl.NumberFormat("id-ID").format(n)}`

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
    `estimated cost IDR ${queries.size * 2} (one Maps request each), plus one ` +
    `more for each district whose name finds nothing and has a postal code to fall back on.`,
  )
  console.log(APPLY ? "\nAPPLYING changes.\n" : "\nDRY RUN — nothing will be written. Re-run with --apply.\n")

  const matched: { place: Place; areaId: string; areaName: string }[] = []
  // District certain, exact code not. Good enough to price against, not good
  // enough to store as somebody's address — so these are reported and never
  // written.
  const approximate: { place: Place; areaId: string; areaName: string }[] = []
  // The areas each unresolved place DID see are kept, so --rates can quote a
  // price for them without paying for the searches a second time. Deciding
  // whether a district or a postal code is the wrong field is a question about
  // money, and the money was one call away.
  const needsHuman: {
    place: Place
    reason: string
    candidates: string[]
    nameAreas: BiteshipArea[]
    postalAreas: BiteshipArea[]
  }[] = []

  // One district can appear several times over, once per postal code. The
  // search is the billable part and its answer is the same every time, so it is
  // made once and reused.
  const searched = new Map<string, Awaited<ReturnType<typeof searchAreas>>>()

  // How many were saved by the postal-code fallback rather than the name.
  let recovered = 0
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
      needsHuman.push({ place, reason: "search failed", candidates: [], nameAreas: [], postalAreas: [] })
      continue
    }

    // No early exit on an empty answer: a district whose NAME finds nothing is
    // the exact case the postal code below rescues, and returning here skipped
    // it -- which is how five Bekasi districts stayed unmapped through a run
    // that was written to save them.
    let result: ReturnType<typeof matchArea> = areas.length
      ? matchArea(areas, place)
      : { kind: "none" }

    // Searching for the district by name failed. Try its postal code instead:
    // the code is the one field both sides write the same way, so it gets past
    // our own spelling -- "PONDOKGEDE" for their "Pondok Gede", which is five
    // Bekasi districts and about seventy customers on its own. A second
    // billable search, made only where the first found nothing usable.
    let postalAreas: BiteshipArea[] = []
    if (result.kind !== "matched" && place.kodePos) {
      const byCode = searched.get(place.kodePos) ?? await searchAreas(place.kodePos)
      searched.set(place.kodePos, byCode)
      postalAreas = byCode
      const second = matchByPostal(byCode, place)
      if (second.kind === "matched") {
        recovered += place.customers
        result = second
      }
    }

    if (result.kind !== "matched" && !areas.length) {
      needsHuman.push({ place, reason: "no results", candidates: [], nameAreas: areas, postalAreas })
      continue
    }

    if (result.kind === "matched") {
      const row = { place, areaId: result.area.id, areaName: result.area.name }
      ;(result.approximate ? approximate : matched).push(row)
    } else {
      needsHuman.push({
        nameAreas: areas,
        postalAreas,
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
  console.log(`✓ ${matched.length} places matched confidently` + (recovered ? ` (${recovered} customers via their postal code, after the district name found nothing)` : ""))
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

  if (RATES) {
    const [origin] = (await sql`
      SELECT biteship_area_id AS id, code FROM warehouses WHERE code = 'CIMAHI'
    `) as unknown as { id: string; code: string }[]
    const stored = await storedRates()
    console.log(`\nWhat a kilo costs from ${origin.code}, ours against JNE's own quote:`)
    console.log("   ours = customer_warehouse_ongkir × 1kg, the invoice's own shipping line\n")
    let cheaper = 0, dearer = 0, same = 0
    for (const row of [...matched, ...approximate]) {
      const p = row.place
      const s = stored.get(`${p.kota}|${p.kecamatan}|${p.kodePos}`)
      let quote: number | null = null
      try {
        const rates = await courierRates(origin.id, row.areaId, 1000)
        const reg = rates.find((r) => /^(reg|ctc)$/i.test(r.serviceCode)) ?? rates[0]
        quote = reg ? reg.price : null
      } catch { quote = null }
      const oursText = !s ? "—" : s.lo === s.hi ? rupiah(s.lo) : `${rupiah(s.lo)}–${rupiah(s.hi)}`
      const diff = s && quote != null && s.lo === s.hi ? quote - s.lo : null
      if (diff != null) { if (diff > 0) dearer++; else if (diff < 0) cheaper++; else same++ }
      console.log(
        `   ${p.kota} / ${p.kecamatan}${p.kodePos ? ` ${p.kodePos}` : ""}  (${p.customers}c)` +
        `  ours ${oursText}  jne ${quote == null ? "—" : rupiah(quote)}` +
        `${diff == null ? "" : diff === 0 ? "  same" : `  ${diff > 0 ? "+" : ""}${rupiah(diff)}`}`,
      )
    }
    console.log(`\n   ${same} the same, ${dearer} where JNE quotes MORE than we charge, ${cheaper} where it quotes less.`)

    // The unresolved places, priced both ways they could be read.
    //
    // A place is unresolved because two readings of it disagree: what her
    // district says and what her postal code says. Each reading has a price,
    // and where the two prices are equal the disagreement costs nothing and
    // the choice can wait. Where they differ, the gap is what the decision is
    // actually worth -- which is the thing a list of place names could never
    // say.
    console.log("\nUnresolved places, priced both ways:")
    console.log("   district = what her kecamatan points at; code = what her kode pos points at\n")
    for (const h of needsHuman) {
      const p = h.place
      const s2 = stored.get(`${p.kota}|${p.kecamatan}|${p.kodePos}`)
      const oursText = !s2 ? "—" : s2.lo === s2.hi ? rupiah(s2.lo) : `${rupiah(s2.lo)}–${rupiah(s2.hi)}`

      // One district among the name results, whatever its codes: a courier
      // prices by district, so any of its areas quotes the same.
      const districts = new Set(h.nameAreas.map((a) => a.name.split(",")[0]?.trim()))
      const byDistrict = districts.size === 1 ? h.nameAreas[0] : null
      // The single area carrying her code, where there is one.
      const carrying = h.postalAreas.filter(
        (a) => (a.postalCode ?? a.name.match(/\b(\d{5})\b\s*$/)?.[1] ?? "") === p.kodePos,
      )
      const byCode = carrying.length === 1 ? carrying[0] : null

      const quote = async (a: BiteshipArea | null) => {
        if (!a) return null
        try {
          const rates = await courierRates(origin.id, a.id, 1000)
          const reg = rates.find((r) => /^(reg|ctc)$/i.test(r.serviceCode)) ?? rates[0]
          return reg ? reg.price : null
        } catch { return null }
      }
      const [dq, cq] = [await quote(byDistrict), await quote(byCode)]
      const agree = dq != null && cq != null && dq === cq

      console.log(
        `   ${p.kota} / ${p.kecamatan}${p.kodePos ? ` ${p.kodePos}` : ""}  (${p.customers}c)  ours ${oursText}` +
        `  district ${dq == null ? "—" : rupiah(dq)}${byDistrict ? ` [${byDistrict.name}]` : ""}` +
        `  code ${cq == null ? "—" : rupiah(cq)}${byCode ? ` [${byCode.name}]` : ""}` +
        `${agree ? "  — both the same, so the disagreement costs nothing" : ""}`,
      )
    }
  }

  if (!APPLY) {
    console.log("\nDry run complete. Nothing written.")
    await sql.end()
    return
  }

  // District-only rows join the write only when asked for, and never the three
  // held back.
  const held = ACCEPT_DISTRICT ? approximate.filter((a) => isHeld(a.place)) : []
  const writing = ACCEPT_DISTRICT
    ? [...matched, ...approximate.filter((a) => !isHeld(a.place))]
    : matched
  if (held.length) {
    console.log(`\nHolding ${held.length} place(s) back — their price disagrees and each needs a decision:`)
    for (const h of held) console.log(`   ${h.place.kota} / ${h.place.kecamatan} ${h.place.kodePos}`)
  }

  let updated = 0
  for (const m of writing) {
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
  console.log(`\nApplied: ${updated} customers mapped across ${writing.length} places.`)
  await sql.end()
}

main().catch(async (err) => {
  console.error("Backfill failed:", err)
  await sql.end()
  process.exit(1)
})
