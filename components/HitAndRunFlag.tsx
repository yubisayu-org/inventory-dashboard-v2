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
      aria-label={`Pernah kabur: ${stamps.join(", ")}`}
      className="inline-grid place-items-center w-[17px] h-[17px] shrink-0 rounded border border-amber-300 bg-amber-50 text-amber-700 text-[10px] leading-none cursor-help"
    >
      ⚑
    </span>
  )
}
