import { randomBytes } from "node:crypto"
import sql from "@/lib/db-pool"

/**
 * The unguessable part of a trip's catalogue URL.
 *
 * Ten hex characters is forty bits: nobody guesses it, and it fits on one line
 * of a WhatsApp message next to the domain.
 */
function freshSecret(): string {
  return randomBytes(5).toString("hex")
}

/**
 * A trip's catalogue link, minting one the first time it is asked for.
 *
 * Stored rather than derived from the event name. Deriving meant a link could
 * never be withdrawn — the only lever was a salt shared by every trip — and a
 * secret shared once is shared forever. Stored, revoking is giving this one
 * trip a new secret and leaving every other link alone.
 *
 * Minted lazily because most trips never need one, and a column full of secrets
 * for events nobody published is a column of things to leak.
 */
export async function katalogSecret(event: string): Promise<string | null> {
  const [row] = await sql`SELECT catalog_secret FROM events WHERE name = ${event}`
  if (!row) return null
  if (row.catalog_secret) return row.catalog_secret as string

  const secret = freshSecret()
  await sql`
    UPDATE events SET catalog_secret = ${secret}, updated_at = NOW()
    WHERE name = ${event} AND catalog_secret IS NULL
  `
  // Re-read rather than trusting the write: two requests can race for the first
  // link, and the loser must return the winner's secret, not its own.
  const [saved] = await sql`SELECT catalog_secret FROM events WHERE name = ${event}`
  return (saved?.catalog_secret as string) ?? secret
}

/**
 * Retire a trip's link and issue another.
 *
 * What "the link got out" looks like as an action. Everyone who had the old URL
 * loses access; everyone else is unaffected, which is the whole point of a
 * secret per trip.
 */
export async function rotateKatalogSecret(event: string): Promise<string> {
  const secret = freshSecret()
  await sql`UPDATE events SET catalog_secret = ${secret}, updated_at = NOW() WHERE name = ${event}`
  return secret
}

/**
 * The trip a link points at, or null.
 *
 * Only while the trip is running: a closed trip's catalogue goes dark, which is
 * also when its full-size originals are deleted.
 */
/**
 * The full link, as it is pasted into a group.
 *
 * The origin comes from the environment because the bot runs somewhere with no
 * request to infer it from. Falls back to a relative path rather than guessing
 * a domain: a wrong absolute URL is worse than an obviously incomplete one.
 */
export function catalogueUrl(secret: string): string {
  const origin = (process.env.PUBLIC_SITE_URL ?? "").replace(/\/$/, "")
  return `${origin}/katalog/${secret}`
}

export async function eventForSecret(secret: string): Promise<string | null> {
  if (!secret) return null
  const [row] = await sql`
    SELECT name FROM events WHERE catalog_secret = ${secret} AND is_active
  `
  return row ? (row.name as string) : null
}
