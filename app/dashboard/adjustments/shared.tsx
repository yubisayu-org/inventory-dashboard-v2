// Shared bits of the adjustment form, reused by:
//   - /dashboard/adjustments (top-of-page inline add form)
//   - /dashboard/invoice (per-row "+ Adjustment" modals on EventCard and PaymentStatusPanel)
// Keep wording and styling here so the two entry points stay in lockstep.

export const DEFAULT_DESCRIPTIONS = ["Free Shipping", "Shipping Difference"] as const

export function descriptionOptions(extra: string[] = []) {
  const all = new Set<string>([...DEFAULT_DESCRIPTIONS, ...extra.filter(Boolean)])
  return Array.from(all).map((d) => ({ value: d, label: d }))
}

export function AmountSignHint({ value }: { value: string }) {
  const n = Number(value)
  const filled = value !== "" && Number.isFinite(n) && n !== 0
  const tone = !filled
    ? "text-amber-700 bg-amber-50 border-amber-200"
    : n > 0
      ? "text-red-700 bg-red-50 border-red-200"
      : "text-green-700 bg-green-50 border-green-200"
  const message = !filled
    ? <><strong>Positive</strong> = Biaya Lainnya (adds to total). <strong>Negative</strong> = Diskon (reduces total).</>
    : n > 0
      ? <>Will display as <strong>Biaya Lainnya</strong> and <strong>add</strong> to the customer&apos;s total.</>
      : <>Will display as <strong>Diskon</strong> and <strong>reduce</strong> the customer&apos;s total.</>
  return (
    <p className={`text-[11px] mt-1 px-2 py-1.5 leading-snug rounded-md border ${tone}`}>
      {message}
    </p>
  )
}
