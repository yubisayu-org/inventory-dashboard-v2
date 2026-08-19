export function fmt(n: number): string {
  return n.toLocaleString("id-ID")
}

export function fmtNullable(n: number | null | undefined, fallback = "—"): string {
  return n == null ? fallback : fmt(n)
}

/**
 * Strips a leading "@" from an Instagram handle so it can be displayed
 * without the prefix. Storage and lookups keep the original value via
 * normalizeId() — this is display-only.
 */
export function displayIg(id: string | null | undefined): string {
  return (id ?? "").replace(/^@/, "")
}

/**
 * The digits of a WhatsApp sender's JID.
 *
 * Shown beside a claimant's handle because finding them in a group of a hundred
 * to ask about a substitution is a search, and a phone searches on digits.
 * Copes with a bare JID, a device-suffixed one, and a privacy id.
 */
export function senderDigits(jid: string): string {
  return (jid.split("@")[0] ?? "").split(":")[0].replace(/\D/g, "")
}

/**
 * "17/08/2026 09.41.22" → "17/08 09.41".
 *
 * Seconds and the year are noise here: a claim from ten minutes ago and one
 * from two days ago are asked about differently, and nothing is decided at a
 * finer resolution than that.
 */
export function claimedAt(stamp: string): string {
  const [date = "", time = ""] = stamp.split(" ")
  const [day, month] = date.split("/")
  const [hour, minute] = time.split(".")
  if (!day || !hour) return stamp
  return `${day}/${month} ${hour}.${minute}`
}
