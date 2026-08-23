export type Verdict = "accept" | "decline" | "unclear"

/**
 * Reactions carry the exact message they were applied to, which makes them the
 * most reliable answer channel — no quote chain to walk, no text to parse.
 */
const ACCEPT_EMOJI = new Set(["\u{1F44D}", "\u{1F44C}", "❤️", "❤", "✅", "\u{1F64F}"])
const DECLINE_EMOJI = new Set(["\u{1F44E}", "❌", "\u{1F645}"])

/**
 * Idioms that contain a negator but mean yes.
 *
 * "ga papa" is literally "not a problem" — a customer agreeing. Checked before
 * anything else, because every later rule would read that "ga" as a refusal.
 */
const ACCEPT_IDIOMS = ["ga papa", "gapapa", "gak papa", "ga apa apa", "gpp", "no problem"]

/** Unambiguous refusals, whole phrases. */
const DECLINE_PHRASES = [
  "ga jadi", "gajadi", "gak jadi", "nggak jadi",
  "ga usah", "gausah", "gak usah",
  "engga", "enggak", "nggak", "tidak",
  "skip", "batal", "cancel", "pass", "no",
]

/**
 * Bare negators. Alone they are a complete refusal; inside a sentence they are
 * usually asking something ("muat ga ya?"), so they only decide the answer when
 * they stand alone or negate a positive word.
 */
const NEGATORS = ["ga", "gak", "engga", "enggak", "nggak", "tidak"]

const ACCEPT_WORDS = [
  "ok", "oke", "okay", "boleh", "mau", "iya", "yaudah", "yaudahlah",
  "yuk", "lanjut", "ambil", "deal", "sip", "siap", "gas",
]

/**
 * Normalize to bare words so matching can be word-exact.
 *
 * Substring matching is what gets this wrong: "ga mau" contains "mau", and
 * reading that as a yes would buy something the customer just refused.
 */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean)
}

function hasPhrase(list: string[], tokens: string[]): boolean {
  const joined = ` ${tokens.join(" ")} `
  return list.some((phrase) => joined.includes(` ${phrase} `))
}

/**
 * Decide what a customer's answer to a substitution offer means.
 *
 * Unclear is a real outcome, not a failure: it sends the claim to review, where
 * the owner reads the message themselves. Guessing would silently change what
 * someone is charged for — and Indonesian makes guessing easy to get wrong,
 * since "ga papa" (fine) and "ga mau" (no) start the same way.
 */
export function classifyAnswer(input: { text?: string; emoji?: string }): Verdict {
  if (input.emoji !== undefined) {
    if (ACCEPT_EMOJI.has(input.emoji)) return "accept"
    if (DECLINE_EMOJI.has(input.emoji)) return "decline"
    return "unclear"
  }

  if (input.text === undefined) return "unclear"
  const tokens = words(input.text)
  if (tokens.length === 0) return "unclear"

  // Idioms first: they contain a negator but mean the opposite of one.
  if (hasPhrase(ACCEPT_IDIOMS, tokens)) return "accept"

  if (hasPhrase(DECLINE_PHRASES, tokens)) return "decline"

  // A bare negator standing alone is a complete answer.
  if (tokens.length === 1 && NEGATORS.includes(tokens[0])) return "decline"

  // A negator immediately before a positive word negates it: "ga mau",
  // "gak boleh". Anywhere else — "muat ga ya?" — it is part of a question, and
  // the message goes to review rather than being read as a refusal.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (NEGATORS.includes(tokens[i]) && ACCEPT_WORDS.includes(tokens[i + 1])) return "decline"
  }

  if (hasPhrase(ACCEPT_WORDS, tokens)) return "accept"
  return "unclear"
}
