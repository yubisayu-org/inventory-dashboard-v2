/**
 * Largest quantity a caption may ask for.
 *
 * A jastip order of more than a dozen of one item is a wholesale request, not a
 * customer's line — and reading a stray number as one would put fifty units on
 * the shopping list.
 */
const MAX_QUANTITY = 20

/**
 * Smallest number that might be a clothing size.
 *
 * The catalogue is Japanese children's wear, sized 50 to 160, and a caption is
 * mostly about size. So anything in that range is left alone unless it carries
 * a unit of its own: "mau 100" is a size wish, "100 pcs" is not a jastip order.
 */
const SIZE_FLOOR = 50

/** Words that mean the number beside them is a count. */
const UNITS = "pcs|pc|pasang|set|setel|buah|biji|lembar|pack|pak|box"
const VERBS = "mau|minta|ambil|order|pesan|beli|tolong|butuh"
const EACH = "masing-?masing|masing2|per ?(?:item|barang|model|motif)|each"

/**
 * How many of an item a caption asks for. One unless it says otherwise.
 *
 * Silence means one, because that is what "yang beruang ya kak" means and it is
 * most of the traffic. A number alone is not enough either — captions are full
 * of sizes, and reading "size 95" as ninety-five units would be a catastrophe
 * dressed as a feature. So a count has to announce itself: a unit after it, a
 * verb of wanting before it, an each-phrase, or the multiplication shorthands
 * people already type.
 *
 * Where the caption says two different things — "mau 2, masing-masing 3" — the
 * larger is taken. Both are the customer asking for more than one, and the
 * cheaper mistake is buying one too many rather than one too few, which is an
 * order that arrives short.
 */
function quantityPatterns(): RegExp[] {
  return [
    // "3 pcs", "2 set", "4 pasang"
    new RegExp(`(\\d{1,3})\\s*(?:${UNITS})\\b`, "g"),
    // "mau 3", "ambil 2", "minta 4"
    new RegExp(`(?:${VERBS})\\s*(\\d{1,3})\\b`, "g"),
    // "masing-masing 4", "masing2 2", "per item 3"
    new RegExp(`(?:${EACH})\\s*(\\d{1,3})\\b`, "g"),
    // "x3", "3x", "@2" — shorthand people type without thinking about it
    /(?:^|\s)[x@](\d{1,3})\b/g,
    /(?:^|\s)(\d{1,3})\s*x(?:\s|$)/g,
  ]
}

export function parseQuantity(note: string): number {
  const text = note.toLowerCase()
  const found: number[] = []
  const patterns = quantityPatterns()

  for (const [index, pattern] of patterns.entries()) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1])
      if (!Number.isFinite(value) || value < 1 || value > MAX_QUANTITY) continue
      // A bare cue plus a size-shaped number is still a size: "mau 100" is
      // someone hoping for a 100, not ordering a hundred. Only an explicit unit
      // — the first pattern — can claim a number that large.
      if (value >= SIZE_FLOOR && index !== 0) continue
      found.push(value)
    }
  }

  return found.length > 0 ? Math.max(...found) : 1
}

/** A bare ordering verb — "mau", "minta", "ambil", and the rest of VERBS —
 *  said on its own, with no number required beside it ("mau dong A11" has
 *  no digit for parseQuantity's own VERBS pattern to anchor to, but the
 *  word alone is still real intent). */
const ORDERING_VERB = new RegExp(`\\b(?:${VERBS})\\b`, "i")

/**
 * Whether a message carries any explicit signal that it's an order, as
 * opposed to just naming a product — a bare ordering verb, or any of
 * `parseQuantity`'s own count patterns (a unit, an each-phrase, an "x3"
 * shorthand). Reuses `parseQuantity`'s exact patterns rather than a second
 * definition of "explicit," since parseQuantity already always returns 1
 * (silence means one) and so can't itself answer "did she actually say
 * anything, or is 1 just the default."
 */
export function hasOrderingIntent(note: string): boolean {
  const text = note.toLowerCase()
  if (ORDERING_VERB.test(text)) return true
  return quantityPatterns().some((p) => p.test(text))
}
