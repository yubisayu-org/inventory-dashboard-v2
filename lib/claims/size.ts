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
  return sizesIn(note)[0] ?? ""
}

/**
 * Every size mentioned in a note, in the order written.
 *
 * The first is what normalizeSize returns and what the claim is filed under.
 * The rest are the ones people add themselves — "size 95, kalau nggak ada 100
 * juga boleh" — and are never acted on automatically: the sentence around them
 * could as easily be "definitely not 100". They are shown to the owner beside
 * her actual words, and it is the owner who decides.
 */
export function sizesIn(note: string): string[] {
  const text = note.toLowerCase()
  const found: string[] = []

  for (const match of text.matchAll(/\d+/g)) {
    const value = Number(match[0])
    if (value < MIN_NUMERIC_SIZE || value > MAX_NUMERIC_SIZE) continue
    const size = String(value)
    if (!found.includes(size)) found.push(size)
  }

  // Letters must stand alone. Word boundaries stop "lucu" reading as L and
  // "kalau" reading as... nothing in particular, but the same rule covers both.
  //
  // Sorted by where they appear so "M atau L" reads M first, matching the
  // numeric pass. LETTER_SIZES is ordered longest-first for matching, which is
  // not the order anybody wrote them in.
  const letters: { size: string; at: number }[] = []
  for (const size of LETTER_SIZES) {
    const at = text.search(new RegExp(`(^|[^a-z])${size.toLowerCase()}([^a-z]|$)`))
    if (at !== -1) letters.push({ size, at })
  }
  for (const { size } of letters.sort((a, b) => a.at - b.at)) {
    if (!found.includes(size)) found.push(size)
  }

  return found
}

/**
 * Sizes she mentioned beyond the one she is filed under.
 *
 * A suggestion for the owner, never an instruction to the machine.
 */
export function alternativeSizes(note: string): string[] {
  return sizesIn(note).slice(1)
}
