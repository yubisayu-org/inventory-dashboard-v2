"use client"

/**
 * The mark beside a customer who has walked away from an order.
 *
 * Quiet on purpose: it is a thing to notice while reading a list, not a verdict
 * about her. The stamps themselves -- which trip, and what she never paid --
 * are on the hover.
 */
export function HitAndRunFlag({ stamps }: { stamps: string[] | undefined }) {
  if (!stamps || stamps.length === 0) return null
  return (
    <span
      title={stamps.join("\n")}
      aria-label={stamps.join(", ")}
      className="shrink-0 text-amber-600 text-xs leading-none cursor-help"
    >
      ⚑
    </span>
  )
}
