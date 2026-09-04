"use client"

import type { DuplicatePayment } from "@/lib/db/payment-duplicates"
import { fmt } from "@/lib/format"

/**
 * What the shop already has, shown at the moment someone is about to record
 * the same money a second time.
 *
 * It asks rather than refuses. Two transfers of the same size days apart are
 * ordinary, and only the bank statement can say which this is — so every path
 * out of here is open, and the one that avoids a second row is offered first.
 */

export type { DuplicatePayment }

/** The sentence changes with what was found, because the right answer does.
 *  A claim she filed herself can be ticked instead; a row the shop typed can
 *  only be looked at again. */
export function describeDuplicate(d: DuplicatePayment): string {
  const when = new Date(`${d.payDate}T00:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
  })
  const money = `Rp ${fmt(d.amount)}`
  const named = d.remarks ? ` — “${d.remarks}”` : ""

  if (d.reportedBy === "customer") {
    return d.isChecked
      ? `She reported ${money} herself on ${when}${named}, and it has already been checked.`
      : `She reported ${money} herself on ${when}${named}, and it is still waiting to be checked.`
  }
  return d.isChecked
    ? `#${d.id} already records ${money} on ${when}${named}, checked.`
    : `#${d.id} already records ${money} on ${when}${named}, not checked yet.`
}

export function DuplicatePaymentPrompt({
  duplicate,
  busy = false,
  saveLabel = "Save anyway",
  onTickHers,
  onSaveAnyway,
  onCancel,
}: {
  duplicate: DuplicatePayment
  busy?: boolean
  /** What going ahead is called here — saving a row, or ticking one. */
  saveLabel?: string
  /** Offered only where ticking is both possible and the better answer: her
   *  own claim, not yet checked, and the reader allowed to tick. */
  onTickHers?: () => void
  onSaveAnyway: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
      <p className="font-semibold text-amber-900">{describeDuplicate(duplicate)}</p>
      <p className="mt-1">
        {onTickHers
          ? "Ticking hers counts the money without leaving a second row. Go on only if it was a second transfer."
          : "Go on only if it was a second transfer."}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {onTickHers && (
          <button
            type="button"
            onClick={onTickHers}
            disabled={busy}
            className="rounded-md bg-brand px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            Tick hers instead
          </button>
        )}
        <button
          type="button"
          onClick={onSaveAnyway}
          disabled={busy}
          className={`rounded-md px-2.5 py-1 text-[11px] font-semibold disabled:opacity-50 ${
            onTickHers
              ? "border border-amber-300 bg-white text-amber-900"
              : "bg-brand text-white"
          }`}
        >
          {saveLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-muted disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
