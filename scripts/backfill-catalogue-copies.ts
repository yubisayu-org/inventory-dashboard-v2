import sql from "@/lib/db-pool"
import { localPostImage } from "@/lib/whatsapp/post-image"
import { writeCatalogueCopy } from "@/lib/whatsapp/catalogue"

/**
 * Write the customer-facing copy of every shelf that has none.
 *
 * Capture writes it from now on; this covers what was captured before, and any
 * shelf whose copy failed to write at the time.
 *
 * Run: npx tsx --env-file-if-exists=.env.development.local scripts/backfill-catalogue-copies.ts
 */
async function main() {
  const rows = await sql`
    SELECT id, image_path FROM wa_posts
    WHERE view_path = '' AND archived_at IS NULL
    ORDER BY id
  `
  console.log(`${rows.length} shelf/shelves to encode`)

  let done = 0
  for (const row of rows) {
    try {
      const file = await localPostImage(row.image_path as string)
      const path = await writeCatalogueCopy(row.id as number, row.image_path as string, file)
      if (path) done += 1
      console.log(`post ${row.id}: ${path || "failed"}`)
    } catch (err) {
      // A shelf whose original is missing keeps its empty view_path rather than
      // stopping the run; the rest of the trip still gets copies.
      console.warn(`post ${row.id}: ${(err as Error).message}`)
    }
  }

  console.log(`${done} written`)
  await sql.end()
}

main()
