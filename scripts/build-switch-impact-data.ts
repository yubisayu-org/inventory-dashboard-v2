/**
 * The data behind the ongkir-switch review page.
 *
 * Three tables, written as JSON for the page to embed:
 *
 *   switch-data.json   every rate row where our stored `ongkos_kirim` differs
 *                      from what JNE quoted, EXCLUDING the rows that had no
 *                      rate at all -- the owner approved those outright on
 *                      30 Aug 2026 and does not want them re-listed.
 *   approved-gaps.json those excluded rows, kept so the count can be stated.
 *   stale-data.json    customers whose shipping label names a district their
 *                      columns do not. The label is the address the parcel
 *                      actually went to.
 *
 * Regenerate whenever customers are edited or merged: the page is a snapshot,
 * and a deleted customer keeps appearing until this is re-run. That is exactly
 * how `devigemala_old` outlived her own deletion.
 *
 *   npx tsx --env-file=.env.local scripts/build-switch-impact-data.ts [outDir]
 */

import sql from "@/lib/db-pool"
import { writeFileSync } from "node:fs"

const OUT = process.argv[2] ?? "."

const letters = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "")
/** A label line naming a street is the parser guessing, not a district. */
const READS_LIKE_A_STREET =
  /(^|\s)(jl\.?|jalan|blok|no\.?\s*\d|rt[\s.]|rw[\s.]|perum|komplek|kompleks|apart|gang|gg\.)/i

/** The district line the registration form pastes as the label's last line. */
function labelDistrict(dataDiri: string) {
  const lines = dataDiri.split("\n").map((s) => s.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ""
  const m = last.match(/^([^,]+),\s*(.+?)\s*(\d{5})?$/)
  if (!m) return null
  const [, kec, kotaRaw, pos] = m
  if (/^(email|telepon|nama)/i.test(kec)) return null
  return { kec, kota: kotaRaw.replace(/\s*\d{5}\s*$/, ""), pos: pos ?? "", last }
}

async function main() {
  // Who has moved, by the only evidence there is: the label disagreeing with
  // the columns. Also who was CORRECTED today, from the audit log -- their
  // remaining rate difference is real and separate from the move.
  const cust = (await sql`
    SELECT lower(replace(instagram_id, '@', '')) AS h, COALESCE(kecamatan, '') AS kec,
           COALESCE(kota, '') AS kota, COALESCE(data_diri, '') AS dd
      FROM customers
     WHERE COALESCE(data_diri, '') <> '' AND COALESCE(kecamatan, '') <> ''
  `) as unknown as { h: string; kec: string; kota: string; dd: string }[]

  const moved = new Set<string>()
  const renamed = new Set<string>()
  for (const c of cust) {
    const l = labelDistrict(c.dd)
    if (!l) continue
    const kecSame = letters(l.kec) === letters(c.kec) ||
      letters(l.kec).includes(letters(c.kec)) || letters(c.kec).includes(letters(l.kec))
    if (kecSame) continue
    const kotaSame = letters(l.kota).includes(letters(c.kota)) ||
      letters(c.kota).includes(letters(l.kota))
    if (!kotaSame && !READS_LIKE_A_STREET.test(l.last)) moved.add(c.h)
    else if (kotaSame) renamed.add(c.h)
  }

  const fixedRows = (await sql.unsafe(`
    SELECT new_row->>'instagram_id' AS h,
           min(old_row->>'kecamatan') || ', ' || min(old_row->>'kota') AS was
      FROM audit.audit_log
     WHERE table_name = 'customers' AND at::date = current_date
       AND old_row->>'kecamatan' IS DISTINCT FROM new_row->>'kecamatan'
     GROUP BY 1
  `)) as unknown as { h: string; was: string }[]
  const fixedMap = new Map(
    fixedRows.map((x) => [String(x.h).toLowerCase().replace(/@/g, ""), x.was]),
  )

  // Everyone sharing a WhatsApp number: the same person entered twice is one
  // decision, not two, and the sibling row often already holds the right rate.
  const phones = (await sql`
    SELECT lower(replace(instagram_id, '@', '')) AS h,
           regexp_replace(COALESCE(whatsapp, ''), '[^0-9]', '', 'g') AS phone
      FROM customers
     WHERE regexp_replace(COALESCE(whatsapp, ''), '[^0-9]', '', 'g') <> ''
  `) as unknown as { h: string; phone: string }[]
  const byPhone = new Map<string, string[]>()
  for (const p of phones) byPhone.set(p.phone, [...(byPhone.get(p.phone) ?? []), p.h])
  const phoneOf = new Map(phones.map((p) => [p.h, p.phone]))

  const rows = (await sql`
    SELECT lower(replace(c.instagram_id, '@', '')) AS handle, COALESCE(c.name, '') AS name,
           COALESCE(c.jalan, '') AS jalan, COALESCE(c.kecamatan, '') AS kecamatan,
           COALESCE(c.kota, '') AS kota, COALESCE(c.provinsi, '') AS provinsi,
           COALESCE(c.kode_pos, '') AS kodepos,
           COALESCE(c.biteship_area_name, '') AS area, COALESCE(c.biteship_area_id, '') AS areaid,
           w.code AS wh, cwo.ongkos_kirim::int AS ours, cwo.biteship_ongkir::int AS bite,
           (cwo.biteship_ongkir - cwo.ongkos_kirim)::int AS delta,
           (SELECT count(*) FROM orders o
             WHERE lower(replace(o.customer, '@', '')) = lower(replace(c.instagram_id, '@', ''))
               AND o.unit > 0)::int AS orders
      FROM customers c
      JOIN customer_warehouse_ongkir cwo ON cwo.customer_id = c.id
      JOIN warehouses w ON w.id = cwo.warehouse_id
     WHERE cwo.biteship_ongkir IS NOT NULL AND cwo.biteship_ongkir <> cwo.ongkos_kirim
  `) as unknown as Record<string, unknown>[]

  // An order line still unshipped prices from the customer's rate, so it moves
  // the day the switch deploys. Anything dispatched is frozen on the shipment.
  const live = (await sql`
    SELECT lower(replace(o.customer, '@', '')) AS handle, w.code AS wh, o.event,
           count(*)::int AS lines, sum(o.unit)::int AS units
      FROM orders o
      JOIN events e ON e.name = o.event
      JOIN warehouses w ON w.id = e.warehouse_id
      JOIN customers c ON lower(replace(c.instagram_id, '@', '')) = lower(replace(o.customer, '@', ''))
      JOIN customer_warehouse_ongkir cwo ON cwo.customer_id = c.id AND cwo.warehouse_id = e.warehouse_id
     WHERE cwo.biteship_ongkir IS NOT NULL AND cwo.biteship_ongkir <> cwo.ongkos_kirim
       AND o.unit > 0
       AND NOT EXISTS (
             SELECT 1 FROM shipments s
              WHERE s.event = o.event
                AND lower(replace(s.customer, '@', '')) = lower(replace(o.customer, '@', ''))
                AND s.tracking_number <> ''
           )
     GROUP BY 1, 2, 3
  `) as unknown as { handle: string; wh: string; event: string; lines: number; units: number }[]
  const liveKey = (h: string, w: string) => `${h}|${w}`
  const liveMap = new Map<string, unknown[]>()
  for (const l of live) {
    const k = liveKey(l.handle, l.wh)
    liveMap.set(k, [...(liveMap.get(k) ?? []), { event: l.event, lines: l.lines, units: l.units }])
  }

  const all: Record<string, unknown>[] = rows.map((r) => {
    const handle = r.handle as string
    const jalanPostals = [...String(r.jalan).matchAll(/\b(\d{5})\b/g)].map((m) => m[1])
    const areaPostal = (String(r.area).match(/(\d{5})\s*$/) ?? [])[1] ?? ""
    const conflict = jalanPostals.length > 0 &&
      !jalanPostals.includes(r.kodepos as string) && !jalanPostals.includes(areaPostal)

    const cat = r.ours === 0 ? "gap"
      : conflict ? "suspect"
      : Math.abs(r.delta as number) >= 5000 ? "big"
      : "small"
    const origin = fixedMap.has(handle) ? "fixed"
      : moved.has(handle) ? "moved"
      : renamed.has(handle) ? "renamed"
      : "notrace"

    const phone = phoneOf.get(handle)
    const siblings = phone ? (byPhone.get(phone) ?? []).filter((h) => h !== handle) : []
    return {
      ...r, cat, origin,
      live: liveMap.get(liveKey(handle, r.wh as string)) ?? [],
      wasAddress: fixedMap.get(handle) ?? null,
      jalanPos: jalanPostals[0] ?? null,
      siblings,
    }
  })

  // Mark only the siblings that are IN the list -- those are one decision made
  // twice. Siblings outside it still show in the row's detail.
  const inList = new Set(all.filter((r) => r.cat !== "gap").map((r) => r.handle as string))
  for (const r of all) {
    r.sameNumber = (r.siblings as string[]).filter((h) => inList.has(h))
    r.otherRows = (r.siblings as string[]).filter((h) => !inList.has(h))
    delete (r as Record<string, unknown>).siblings
  }

  const review = all.filter((r) => r.cat !== "gap")
  const gaps = all.filter((r) => r.cat === "gap")

  const stale: Record<string, unknown>[] = []
  const full = (await sql`
    SELECT c.id, lower(replace(c.instagram_id, '@', '')) AS handle, COALESCE(c.name, '') AS name,
           COALESCE(c.kecamatan, '') AS kec, COALESCE(c.kota, '') AS kota,
           COALESCE(c.kode_pos, '') AS pos, COALESCE(c.provinsi, '') AS provinsi,
           COALESCE(c.jalan, '') AS jalan, COALESCE(c.biteship_area_name, '') AS area,
           COALESCE(c.data_diri, '') AS dd,
           (SELECT count(*) FROM orders o
             WHERE lower(replace(o.customer, '@', '')) = lower(replace(c.instagram_id, '@', ''))
               AND o.unit > 0)::int AS orders,
           (SELECT max(o.created_at) FROM orders o
             WHERE lower(replace(o.customer, '@', '')) = lower(replace(c.instagram_id, '@', ''))) AS last_order,
           (SELECT x.ongkos_kirim::int FROM customer_warehouse_ongkir x
             WHERE x.customer_id = c.id AND x.warehouse_id = 1) AS cimahi,
           (SELECT x.ongkos_kirim::int FROM customer_warehouse_ongkir x
             WHERE x.customer_id = c.id AND x.warehouse_id = 2) AS depok
      FROM customers c
     WHERE COALESCE(c.data_diri, '') <> '' AND COALESCE(c.kecamatan, '') <> ''
  `) as unknown as Record<string, unknown>[]

  for (const x of full) {
    const l = labelDistrict(x.dd as string)
    if (!l) continue
    const kecSame = letters(l.kec) === letters(x.kec as string) ||
      letters(l.kec).includes(letters(x.kec as string)) ||
      letters(x.kec as string).includes(letters(l.kec))
    if (kecSame) continue
    const kotaSame = letters(l.kota).includes(letters(x.kota as string)) ||
      letters(x.kota as string).includes(letters(l.kota))
    stale.push({
      handle: x.handle, name: x.name, orders: x.orders,
      lastOrder: x.last_order ? new Date(x.last_order as string).toISOString().slice(0, 10) : null,
      kec: x.kec, kota: x.kota, pos: x.pos, provinsi: x.provinsi,
      lkec: l.kec, lkota: l.kota, lpos: l.pos,
      area: x.area, jalan: x.jalan, label: x.dd, cimahi: x.cimahi, depok: x.depok,
      cat: !kotaSame ? (READS_LIKE_A_STREET.test(l.last) ? "unsure" : "moved") : "renamed",
    })
  }

  writeFileSync(`${OUT}/switch-data.json`, JSON.stringify(review))
  writeFileSync(`${OUT}/approved-gaps.json`, JSON.stringify(gaps))
  writeFileSync(`${OUT}/stale-data.json`, JSON.stringify(stale))

  const count = (f: string, v: string) => review.filter((r) => (r as Record<string, unknown>)[f] === v).length
  console.log(`review   ${review.length} rows · ${new Set(review.map((r) => r.handle)).size} customers`)
  console.log(`   big ${count("cat", "big")}  small ${count("cat", "small")}  suspect ${count("cat", "suspect")}`)
  console.log(`   fixed ${count("origin", "fixed")}  moved ${count("origin", "moved")}  renamed ${count("origin", "renamed")}  notrace ${count("origin", "notrace")}`)
  console.log(`   live ${review.filter((r) => (r.live as unknown[]).length).length}  shared-number ${review.filter((r) => (r.sameNumber as string[]).length).length}`)
  console.log(`approved ${gaps.length} rows · ${new Set(gaps.map((r) => r.handle)).size} customers`)
  console.log(`stale    ${stale.length} (moved ${stale.filter((s) => s.cat === "moved").length}, unsure ${stale.filter((s) => s.cat === "unsure").length}, renamed ${stale.filter((s) => s.cat === "renamed").length})`)
  await sql.end()
}

main().catch(async (err) => {
  console.error("Build failed:", err)
  await sql.end()
  process.exit(1)
})
