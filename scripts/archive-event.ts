import sql from "@/lib/db-pool"
import { archiveEvent } from "@/lib/whatsapp/archive"

/**
 * Drop the full-size shelves of a finished trip, keeping the catalogue copies.
 *
 * Run: npx tsx --env-file-if-exists=.env.development.local scripts/archive-event.ts LSKR202603
 */
async function main() {
  const event = process.argv[2]
  if (!event) {
    console.error("usage: archive-event.ts <EVENT>")
    process.exit(1)
  }

  const result = await archiveEvent(event)
  console.log(`${result.event}: ${result.archived} archived, ${result.skipped} left alone`)
  await sql.end()
}

main()
