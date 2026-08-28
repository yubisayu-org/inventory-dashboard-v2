"use client"

import { useCallback, useRef, useState } from "react"
import { useModalDismiss } from "@/hooks/useModalDismiss"

export type ShrinkCause = "staff_mistake" | "customer_changed_mind"

/**
 * Why an order just got smaller than what was bought for it.
 *
 * Both answers put the units on the shelf -- the stock is real either way --
 * so this is not a gate, it is a record. A month later the Inventory row is
 * where somebody looks, and "we bought two by accident" and "she asked us not
 * to" are not the same story.
 *
 * Asked with real buttons rather than a browser confirm, which has only OK and
 * Cancel: the question has three answers, and overloading Cancel to mean
 * "customer changed her mind" made the one button that means abandon
 * everywhere else in the app mean something else here.
 */
export function StrandedUnitsDialog({
  units,
  onChoose,
  onClose,
}: {
  units: number
  onChoose: (cause: ShrinkCause) => void
  onClose: () => void
}) {
  useModalDismiss(onClose)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl w-full max-w-sm p-5 flex flex-col gap-3 relative"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close without saving"
          className="absolute top-3 right-3 text-faint hover:text-foreground transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <h3 className="text-sm font-semibold text-foreground pr-6">
          Why is the quantity lower?
        </h3>
        <p className="text-xs text-muted-strong">
          {units} unit{units === 1 ? "" : "s"} already bought {units === 1 ? "is" : "are"} no longer
          on this order. {units === 1 ? "It goes" : "They go"} to Inventory as stock ready to sell —
          the answer is recorded there and on the order.
        </p>

        <div className="flex flex-col gap-2 mt-1">
          <button
            type="button"
            onClick={() => onChoose("staff_mistake")}
            className="w-full text-left px-3 py-2.5 rounded-lg border border-cream-border hover:border-brand hover:bg-brand-light transition-colors"
          >
            <div className="text-sm font-medium text-foreground">Staff Correction</div>
            <div className="text-xs text-muted">Typed twice, or the wrong number</div>
          </button>
          <button
            type="button"
            onClick={() => onChoose("customer_changed_mind")}
            className="w-full text-left px-3 py-2.5 rounded-lg border border-cream-border hover:border-brand hover:bg-brand-light transition-colors"
          >
            <div className="text-sm font-medium text-foreground">Customer Ask</div>
            <div className="text-xs text-muted">She asked to reduce it after we bought</div>
          </button>
        </div>

        <p className="text-[11px] text-faint">
          Closing this saves nothing — the order stays as it was.
        </p>
      </div>
    </div>
  )
}

/**
 * Ask the question from anywhere, and render it once.
 *
 * Both the edit modal and the inline cells can strand a bought unit, so both
 * have to ask -- and the asking has to reach an async save function that is not
 * a component. The promise is resolved by whichever button is pressed.
 */
export function useShrinkCause(): {
  ask: (units: number) => Promise<ShrinkCause | null>
  dialog: React.ReactNode
} {
  const [units, setUnits] = useState<number | null>(null)
  const pending = useRef<((cause: ShrinkCause | null) => void) | null>(null)

  const settle = useCallback((cause: ShrinkCause | null) => {
    setUnits(null)
    pending.current?.(cause)
    pending.current = null
  }, [])

  const ask = useCallback((n: number) => {
    setUnits(n)
    return new Promise<ShrinkCause | null>((resolve) => { pending.current = resolve })
  }, [])

  return {
    ask,
    dialog: units == null ? null : (
      <StrandedUnitsDialog units={units} onChoose={settle} onClose={() => settle(null)} />
    ),
  }
}
