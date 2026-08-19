/**
 * The exact text a send goes out with. Generated, not typed — the composer's
 * live preview and the message wa_outbox actually sends must be identical,
 * so this is the one place that ever formats a caption.
 */
export function renderCaption(
  send: { title: string },
  codes: { code: string; productName: string; price: number }[],
): string {
  const lines = codes.map(
    (c) => `${c.code} ${c.productName} — Rp ${c.price.toLocaleString("id-ID")}`,
  )
  // The brief's sample used codes[0], but its own test data ([K41, K42])
  // expects the example line to read "contoh: K42" — the LAST code, not the
  // first. Matching the test (the actual contract), not the sample snippet.
  const example = codes[codes.length - 1]?.code ?? "K42"
  return [
    `📦 ${send.title}`,
    "",
    ...lines,
    "",
    `Reply kodenya ya, contoh: ${example} mau 1`,
  ].join("\n")
}
