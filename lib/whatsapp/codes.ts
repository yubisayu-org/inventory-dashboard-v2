/** Letters a code can start with. I, O and S are dropped: they read as 1, 0, 5. */
export const CODE_LETTERS = "ABCDEFGHJKLMNPQRTUVWXYZ"

const CODE_PATTERN = new RegExp(`\\b([${CODE_LETTERS}])(\\d{2})\\b`, "gi")

/**
 * The code after the highest one in `usedCodes`, within one event.
 *
 * Not "the first unused code": removing a middle code during composing must
 * not have the next attach reuse it (see the spec's "Codes" section) — only
 * the last-ever-issued code matters, so this is a max-plus-one, not a scan
 * for a gap.
 */
export function nextCode(usedCodes: string[]): string {
  if (usedCodes.length === 0) return `${CODE_LETTERS[0]}01`

  let maxLetterIndex = 0
  let maxDigit = 0
  for (const code of usedCodes) {
    const letter = code[0]
    const digit = Number.parseInt(code.slice(1), 10)
    const letterIndex = CODE_LETTERS.indexOf(letter)
    if (letterIndex > maxLetterIndex || (letterIndex === maxLetterIndex && digit > maxDigit)) {
      maxLetterIndex = letterIndex
      maxDigit = digit
    }
  }

  if (maxDigit < 99) return `${CODE_LETTERS[maxLetterIndex]}${String(maxDigit + 1).padStart(2, "0")}`

  const nextLetterIndex = maxLetterIndex + 1
  if (nextLetterIndex >= CODE_LETTERS.length) {
    throw new Error("code alphabet exhausted for this event — 2 277 codes issued")
  }
  return `${CODE_LETTERS[nextLetterIndex]}01`
}

/** Every code-shaped token in `text`, uppercased, in the order they appear. */
export function parseCodes(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(CODE_PATTERN)) {
    found.push(`${match[1].toUpperCase()}${match[2]}`)
  }
  return found
}
