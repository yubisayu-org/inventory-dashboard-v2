export type Command =
  | { kind: "connect" }
  | { kind: "open"; store: string }
  | { kind: "close" }
  | { kind: "rekap" }
  | { kind: "katalog" }

/**
 * Read a command out of a message, or decide it was not one.
 *
 * Indonesian words, because that is what gets typed standing in a shop. The
 * grammar is deliberately tiny: a leading slash, one word, and for /mulai
 * everything after it as the store name — no flags, no quoting, nothing to get
 * wrong one-handed.
 *
 * Anything unrecognised returns null and the caller stays silent. The group is
 * full of humans, and a bot correcting their typing is noise nobody asked for.
 */
export function parseCommand(text: string): Command | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null

  const spaceAt = trimmed.search(/\s/)
  const word = (spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt)).toLowerCase()
  const rest = spaceAt === -1 ? "" : trimmed.slice(spaceAt).trim().replace(/\s+/g, " ")

  switch (word) {
    case "/connect":
      return { kind: "connect" }
    case "/mulai":
      // No store is allowed on purpose: it can be filled in from the dashboard,
      // and refusing would mean standing in a shop arguing with a bot.
      return { kind: "open", store: rest }
    case "/selesai":
      return { kind: "close" }
    case "/rekap":
      return { kind: "rekap" }
    case "/katalog":
      return { kind: "katalog" }
    default:
      return null
  }
}
