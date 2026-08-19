import sharp from "sharp"
import sql from "@/lib/db-pool"
import { localPostImage } from "@/lib/whatsapp/post-image"

/**
 * Re-measure the shelves captured before the dimensions bug was fixed.
 *
 * Every post captured from WhatsApp recorded the hue histogram's working size —
 * 240 across, whatever the photograph was. Nothing read those columns, so
 * nothing was wrong on screen; this puts the truth back before something does.
 *
 * Run: npx tsx --env-file-if-exists=.env.development.local scripts/backfill-post-dimensions.ts
 */
async function main() {
  const rows = await sql`
    SELECT id, image_path, image_width, image_height FROM wa_posts
    WHERE image_width <= 240
    ORDER BY id
  `
  console.log(`${rows.length} post(s) to re-measure`)

  let fixed = 0
  for (const row of rows) {
    try {
      const file = await localPostImage(row.image_path as string)
      const { width = 0, height = 0 } = await sharp(file).metadata()
      if (!width || !height) {
        console.warn(`post ${row.id}: unreadable, left alone`)
        continue
      }
      await sql`
        UPDATE wa_posts SET image_width = ${width}, image_height = ${height}, updated_at = NOW()
        WHERE id = ${row.id}
      `
      fixed += 1
      console.log(`post ${row.id}: ${row.image_width}x${row.image_height} -> ${width}x${height}`)
    } catch (err) {
      // A shelf whose file is gone from the bucket keeps its wrong numbers
      // rather than stopping the run: they are no worse than before.
      console.warn(`post ${row.id}: ${(err as Error).message}`)
    }
  }

  console.log(`${fixed} re-measured`)
  await sql.end()
}

main()
