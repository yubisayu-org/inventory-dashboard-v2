import sql from "@/lib/db-pool"
import { deletePostImage } from "@/lib/storage"
import { localPostImage } from "./post-image"
import { writeCatalogueCopy } from "./catalogue"

export interface ArchiveResult {
  event: string
  archived: number
  skipped: number
}

/**
 * Drop the full-size shelves of a finished trip, keeping what customers see.
 *
 * A closed trip is a reference, not a shopping list: nobody is walking its
 * aisles, and nobody can claim from it. The 3000px original exists so a price
 * tag can be read in the shop and a late reply can be matched against the rack
 * — both meaningless once the trip is over — while the 230 KB catalogue copy is
 * what makes an old trip still worth looking at. So the original goes and the
 * copy stays: a twentieth of the space, and the rekap picture and naming crops
 * still render, softer.
 *
 * Per trip rather than per named SKU, deliberately. A live trip can always take
 * another claim, and one named slot says nothing about the other five on the
 * same shelf.
 *
 * A shelf with no catalogue copy has one written first. Deleting the only
 * remaining image of a rack would leave the row pointing at nothing, and a
 * screen with no way to show what was on it.
 */
export async function archiveEvent(event: string): Promise<ArchiveResult> {
  const [row] = await sql`SELECT is_active FROM events WHERE name = ${event}`
  if (!row) throw new Error(`no such event: ${event}`)
  if (row.is_active) throw new Error(`${event} is still running`)

  const posts = await sql`
    SELECT id, image_path, view_path FROM wa_posts
    WHERE event = ${event} AND archived_at IS NULL
    ORDER BY id
  `

  let archived = 0
  let skipped = 0
  for (const post of posts) {
    try {
      let viewPath = (post.view_path as string) ?? ""
      if (!viewPath) {
        const file = await localPostImage(post.image_path as string)
        viewPath = await writeCatalogueCopy(post.id as number, post.image_path as string, file)
      }
      // Without a copy there is nothing to keep, so the original stays: a shelf
      // that cannot be shown is worse than a shelf that costs a megabyte.
      if (!viewPath) {
        skipped += 1
        continue
      }

      await deletePostImage(post.image_path as string)
      await sql`UPDATE wa_posts SET archived_at = NOW(), updated_at = NOW() WHERE id = ${post.id}`
      archived += 1
    } catch (err) {
      console.error(`failed to archive post ${post.id}:`, err)
      skipped += 1
    }
  }

  return { event, archived, skipped }
}
