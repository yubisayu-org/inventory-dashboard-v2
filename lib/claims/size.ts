/**
 * Smallest and largest numbers that can plausibly be a clothing size here.
 *
 * The catalogue is Japanese baby and children's wear, sized in centimetres:
 * 50 through 160. The floor matters more than the ceiling — without it every
 * "mau 2" reads as size 2, and a quantity would silently become a variant.
 */
const MIN_NUMERIC_SIZE = 50
const MAX_NUMERIC_SIZE = 160

/** Letter sizes, longest first so XXL is matched before XL and XL before L. */
const LETTER_SIZES = ["XXXL", "XXL", "XL", "S", "M", "L"] as const

/**
 * Read a size out of a customer's note.
 *
 * Returns "" whenever nothing is clearly a size. That is a deliberate answer
 * rather than a failure: claims with no size group into one unsized slot, which
 * is visible on the shopping list and can be split by hand. Guessing would put
 * someone's order under a size they never asked for.
 *
 * The note itself is never modified — see the spec's "Shelf claims carry free
 * text". This only decides which slot the claim belongs to.
 */
export function normalizeSize(note: string): string {
  const text = note.toLowerCase()

  // Numbers first: they are unambiguous once the range filter has run, whereas
  // a stray "l" inside a word is not.
  for (const match of text.matchAll(/\d+/g)) {
    const value = Number(match[0])
    if (value >= MIN_NUMERIC_SIZE && value <= MAX_NUMERIC_SIZE) return String(value)
  }

  // Letters must stand alone. Word boundaries stop "lucu" reading as L and
  // "kalau" reading as... nothing in particular, but the same rule covers both.
  for (const size of LETTER_SIZES) {
    if (new RegExp(`(^|[^a-z])${size.toLowerCase()}([^a-z]|$)`).test(text)) return size
  }

  return ""
}
