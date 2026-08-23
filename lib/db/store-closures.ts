import sql from "@/lib/db-pool"

/**
 * Shops closed for orders on this trip.
 *
 * Closing hides a shop from the catalogue and nothing else. The shelves stay,
 * their claims stay, Group Order still lists what has to be bought, and a
 * customer who still has the photo in WhatsApp can still mark it — the group's
 * history is not ours to retract. What stops is browsing to a rack nobody is
 * going back to.
 *
 * Compared lower-cased throughout, because the store name is typed by hand each
 * time a capture window opens and "Birthday" and "BIRTHDAY" are one shop.
 */
export async function closedStores(event: string): Promise<string[]> {
  const rows = await sql`SELECT store FROM wa_store_closures WHERE event = ${event}`
  return rows.map((r) => r.store as string)
}

export async function closeStore(event: string, store: string): Promise<void> {
  const key = store.trim().toLowerCase()
  if (!key) return
  await sql`
    INSERT INTO wa_store_closures (event, store) VALUES (${event}, ${key})
    ON CONFLICT (event, store) DO NOTHING
  `
}

export async function reopenStore(event: string, store: string): Promise<void> {
  await sql`
    DELETE FROM wa_store_closures
    WHERE event = ${event} AND store = ${store.trim().toLowerCase()}
  `
}
