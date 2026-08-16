/** One sellable combination, e.g. { warna: "hitam", size: "38" }. */
export interface Variant {
  id: string
  dimensions: Record<string, string>
}

export interface TextClaim {
  /** Null when the text did not pin down exactly one variant. */
  variantId: string | null
  quantity: number
  /** Dimension names still unanswered — what the bot asks about. */
  missing: string[]
  /** Options for the first missing dimension, for the question the owner sends. */
  candidates: string[]
}

/**
 * Expand an owner's free-text note into the closed set of variants.
 *
 * Format is deliberately loose — one dimension per line, "name: a/b/c", with
 * numeric ranges written "38-42". The owner types this while posting, on a
 * phone, so anything stricter would not get used.
 *
 * The set is what makes text claims tractable: matching against fifteen known
 * options is a far smaller problem than parsing Indonesian in the open, which
 * is why no per-variant short codes appear in the caption.
 */
export function parseVariantNote(note: string): {
  dimensions: Record<string, string[]>
  variants: Variant[]
} {
  const dimensions: Record<string, string[]> = {}

  for (const line of note.split("\n")) {
    const [rawName, rawValues] = line.split(":")
    if (rawValues === undefined) continue
    const name = rawName.trim().toLowerCase()
    if (name === "") continue

    const values: string[] = []
    for (const chunk of rawValues.split("/")) {
      const value = chunk.trim().toLowerCase()
      if (value === "") continue

      // "38-42" means every size in between, which is how sizes are always
      // written and never means two values.
      const range = value.match(/^(\d+)\s*-\s*(\d+)$/)
      if (range) {
        const from = Number(range[1])
        const to = Number(range[2])
        for (let n = Math.min(from, to); n <= Math.max(from, to); n++) values.push(String(n))
        continue
      }
      values.push(value)
    }
    if (values.length > 0) dimensions[name] = values
  }

  const names = Object.keys(dimensions)
  let combinations: Record<string, string>[] = [{}]
  for (const name of names) {
    const next: Record<string, string>[] = []
    for (const partial of combinations) {
      for (const value of dimensions[name]) next.push({ ...partial, [name]: value })
    }
    combinations = next
  }

  const variants = combinations.map((d) => ({
    id: names.map((n) => d[n]).join("|"),
    dimensions: d,
  }))

  return { dimensions, variants }
}

/**
 * Match a customer's words against the post's variants.
 *
 * Word-boundary matching, not substring: "putih" must not match inside another
 * word, and a bare "40" must not match "402". Everything is compared in lower
 * case with punctuation flattened, because customers type as they speak.
 */
export function resolveText(
  text: string,
  variants: Variant[],
  dimensions: Record<string, string[]>,
): TextClaim {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/)
  const wordSet = new Set(words)

  const chosen: Record<string, string> = {}
  const missing: string[] = []

  for (const [name, values] of Object.entries(dimensions)) {
    const hit = values.find((v) => wordSet.has(v))
    if (hit === undefined) missing.push(name)
    else chosen[name] = hit
  }

  // A number that is not one of this post's dimension values can only be a
  // count. "hitam 38 2pcs" therefore reads as size 38, quantity 2 — the size is
  // claimed by the size dimension before quantity ever looks at the digits.
  const dimensionValues = new Set(Object.values(dimensions).flat())
  let quantity = 1
  for (const word of words) {
    const match = word.match(/^(\d+)(?:pcs|pc|x)?$/)
    if (!match) continue
    if (dimensionValues.has(match[1])) continue
    const n = Number(match[1])
    if (n > 0 && n < 100) quantity = n
  }
  // "x2" and "2x" both appear; the bare-number rule above misses the leading x.
  const explicit = text.toLowerCase().match(/x\s*(\d+)|(\d+)\s*(?:pcs|pc|buah)/)
  if (explicit) quantity = Number(explicit[1] ?? explicit[2])

  const variantId =
    missing.length === 0
      ? (variants.find((v) =>
          Object.entries(chosen).every(([k, val]) => v.dimensions[k] === val),
        )?.id ?? null)
      : null

  return {
    variantId,
    quantity,
    missing,
    candidates: missing.length > 0 ? [...dimensions[missing[0]]] : [],
  }
}
