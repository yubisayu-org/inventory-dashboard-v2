import { createHash } from "node:crypto"

/**
 * Salt for catalogue links. Anything constant will do in development; in
 * production it is what stops someone deriving a link from the event name,
 * which is printed on invoices.
 */
const SALT = process.env.KATALOG_SALT ?? "yubisayu-katalog-dev"

/**
 * The unguessable part of a trip's catalogue URL.
 *
 * Derived rather than stored: a trip already has one identity — its event name
 * — and a second one in a column would need a migration, a backfill and a place
 * in the UI before the idea has been tested. Ten hex characters is 40 bits,
 * which nobody guesses.
 *
 * Deriving does mean the link cannot be revoked without rotating the salt for
 * every trip at once. That is a prototype's trade; a stored per-event secret is
 * the shape this takes if it graduates.
 */
export function katalogSecret(event: string): string {
  return createHash("sha256").update(`${SALT}:${event}`).digest("hex").slice(0, 10)
}

/** The event a catalogue link points at, or null. */
export function eventForSecret(secret: string, events: string[]): string | null {
  return events.find((event) => katalogSecret(event) === secret) ?? null
}
