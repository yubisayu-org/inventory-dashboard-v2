/**
 * The Depok rate rows that the JNE table could not price, from quotes already paid for.
 *
 * 41 mapped customers had no `customer_warehouse_ongkir` row for Depok, and
 * `backfill-missing-warehouse-ongkir.ts` could not fill them because the
 * imported price list has no Depok figure for their district -- 32 places,
 * mostly Sumatra. Asking JNE directly answered 31 of the 32.
 *
 * Those answers are below verbatim, so this writes the rows without asking
 * again. Every number here came back from `POST /v1/rates/couriers`, origin
 * Limo, Depok, one-kilo parcel, JNE, on 30 August 2026. The `cimahi` column is
 * kept beside each one as the sanity check it served when the list was read:
 * Depok sits a little under Cimahi almost everywhere, and the one place it does
 * not (Pasar Kliwon) is flagged.
 *
 * Both columns get the same figure, and deliberately: `ongkos_kirim` because
 * these customers had NO rate at all and a quote is better than the zero a
 * missing row collapses to, `biteship_ongkir` because that is literally what
 * JNE said. Rows that already exist are left alone.
 *
 *   npx tsx --env-file=.env.local scripts/one-off/2026-08-30-depok-rows-from-quotes.ts
 *   npx tsx --env-file=.env.local scripts/one-off/2026-08-30-depok-rows-from-quotes.ts --commit
 */

import sql from "@/lib/db-pool"

const COMMIT = process.argv.includes("--commit")
const rupiah = (n: number) => `Rp ${new Intl.NumberFormat("id-ID").format(n)}`

/** area name → what JNE quoted from Limo, Depok, for one kilo. */
const QUOTED: Record<string, number> = {
  "Batu, Batu, Jawa Timur. 65314": 26000,
  "Baturaja Timur, Ogan Komering Ulu, Sumatera Selatan. 32111": 29000,
  "Bogor Utara - Kota, Bogor, Jawa Barat. 16151": 10000,
  "Bukit Raya, Pekanbaru, Riau. 28281": 44000,
  "Dumai Barat, Dumai, Riau. 28821": 50000,
  "Ilir Barat I, Palembang, Sumatera Selatan. 30137": 23000,
  "Ilir Barat I, Palembang, Sumatera Selatan. 30138": 23000,
  "Ilir Barat I, Palembang, Sumatera Selatan. 30139": 23000,
  "Indralaya Utara, Ogan Ilir, Sumatera Selatan. 30862": 29000,
  "Jambi Selatan, Jambi, Jambi. 36131": 29000,
  "Jambi Timur, Jambi, Jambi. 36141": 29000,
  "Klapanunggal, Bogor, Jawa Barat. 16710": 10000,
  "Kota Baru, Jambi, Jambi. 36128": 29000,
  "Lahat, Lahat, Sumatera Selatan. 31413": 35000,
  "Lawang Kidul, Muara Enim, Sumatera Selatan. 31711": 29000,
  "Mandau, Bengkalis, Riau. 28783": 50000,
  "Marpoyan Damai, Pekanbaru, Riau. 28125": 44000,
  "Marpoyan Damai, Pekanbaru, Riau. 28282": 44000,
  "Medang Kampai, Dumai, Riau. 28825": 56000,
  "Muara Enim, Muara Enim, Sumatera Selatan. 31311": 29000,
  // Dearer from Depok than from Cimahi (11.000). Not a typo -- re-read the run.
  "Pasar Kliwon, Surakarta, Jawa Tengah. 57111": 19000,
  "Pasar Kliwon, Surakarta, Jawa Tengah. 57113": 19000,
  "Payung Sekaki, Pekanbaru, Riau. 28292": 44000,
  "Plaju, Palembang, Sumatera Selatan. 30268": 23000,
  "Sail, Pekanbaru, Riau. 28133": 44000,
  "Sanan Wetan, Blitar, Jawa Timur. 66137": 26000,
  "Seberang Ulu I, Palembang, Sumatera Selatan. 30252": 23000,
  "Sumbergempol, Tulungagung, Jawa Timur. 66291": 29000,
  "Sungai Sembilan, Dumai, Riau. 28826": 56000,
  "Telanaipura, Jambi, Jambi. 36124": 29000,
  "Tenayan Raya, Pekanbaru, Riau. 28281": 44000,
  // "Alam Barajo, Jambi, Jambi. 36129" is absent on purpose: JNE answers
  // "No courier available for requested location" for it, from either origin.
}

async function main() {
  const [depok] = (await sql`
    SELECT id FROM warehouses WHERE code = 'DEPOK'
  `) as unknown as { id: number }[]

  const missing = (await sql`
    SELECT c.id, lower(replace(c.instagram_id, '@', '')) AS handle,
           COALESCE(c.biteship_area_name, '') AS area
      FROM customers c
     WHERE COALESCE(c.biteship_area_id, '') <> ''
       AND NOT EXISTS (
             SELECT 1 FROM customer_warehouse_ongkir cwo
              WHERE cwo.customer_id = c.id AND cwo.warehouse_id = ${depok.id}
           )
     ORDER BY area, handle
  `) as unknown as { id: number; handle: string; area: string }[]

  const fillable = missing.filter((m) => QUOTED[m.area] != null)
  const stuck = missing.filter((m) => QUOTED[m.area] == null)

  console.log(`${missing.length} customers with no Depok row; ${fillable.length} have a quote.`)
  for (const m of fillable) {
    console.log(`   ${m.handle.padEnd(22)} ${rupiah(QUOTED[m.area]).padStart(10)}   ${m.area}`)
  }
  if (stuck.length) {
    console.log(`\n${stuck.length} left alone — JNE would not quote the area:`)
    for (const m of stuck) console.log(`   ${m.handle.padEnd(22)} ${m.area}`)
  }

  if (!COMMIT) {
    console.log(`\nDry run. Nothing written. Add --commit to write ${fillable.length} rows.`)
    await sql.end()
    return
  }

  let written = 0
  for (const m of fillable) {
    const rows = (await sql`
      INSERT INTO customer_warehouse_ongkir
             (customer_id, warehouse_id, ongkos_kirim, biteship_ongkir, biteship_quoted_at, updated_at)
      VALUES (${m.id}, ${depok.id}, ${QUOTED[m.area]}, ${QUOTED[m.area]}, NOW(), NOW())
      ON CONFLICT (customer_id, warehouse_id) DO NOTHING
      RETURNING customer_id
    `) as unknown as { customer_id: number }[]
    written += rows.length
  }
  console.log(`\nWritten: ${written} rows. No existing rate was changed.`)
  await sql.end()
}

main().catch(async (err) => {
  console.error("Failed:", err)
  await sql.end()
  process.exit(1)
})
