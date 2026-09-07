/**
 * What arrived instead, for the items one refund is about.
 *
 * The wrong-delivery map is the whole trip's: every expected item somebody
 * ordered, against whatever turned up in its place. A refund is about one
 * customer's lines, so taking the map wholesale named every substitution on the
 * trip — noi_laban was told six things had arrived instead of her one bag, five
 * of them other people's orders.
 *
 * The refund's note is the list of what she is owed for, so it decides what is
 * named back to her. Nothing matching is an honest answer too: the caller then
 * has no substitute to print, and the wording drops to the sentence that does
 * not name one.
 */
export function substitutesFor(note: string, received: Record<string, string>): string {
  const haystack = note ?? ""
  const names = Object.entries(received)
    .filter(([expected]) => expected.trim() && haystack.includes(expected))
    .map(([, arrived]) => arrived)
    .filter((n) => n?.trim())
  return [...new Set(names)].join(", ")
}
