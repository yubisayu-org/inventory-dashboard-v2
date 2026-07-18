"use client"

import { useEffect, useMemo, useState } from "react"
import { displayIg } from "@/lib/format"
import SearchableSelect from "@/components/SearchableSelect"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import { descriptionOptions, AmountSignHint } from "../adjustments/shared"

const INPUT_CLASS =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

export function AddAdjustmentFromInvoiceModal({
  event,
  customer,
  onClose,
  onSaved,
}: {
  event: string
  customer: string
  onClose: () => void
  onSaved: () => void
}) {
  useModalDismiss(onClose)

  const [description, setDescription] = useState("")
  const [amount, setAmount] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [dbDescriptions, setDbDescriptions] = useState<string[]>([])

  // Pull in previously-typed descriptions so they show up as suggestions.
  useEffect(() => {
    fetch("/api/sheets/adjustments?meta=descriptions")
      .then((res) => res.json())
      .then((data) => setDbDescriptions(data.descriptions ?? []))
      .catch(() => {})
  }, [])

  const descOptions = useMemo(() => descriptionOptions([...dbDescriptions, description]), [dbDescriptions, description])
  const canSubmit = Boolean(amount) && Number(amount) !== 0 && Number.isFinite(Number(amount))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, customer, description, amount: Number(amount) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to save")
      setDone(true)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <form
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Add Adjustment</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {displayIg(customer)} · {event}
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-brand transition-colors shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {done ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
              <circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />
            </svg>
            <p className="text-sm font-medium text-foreground">Adjustment added</p>
            <button type="button" onClick={onClose} className="mt-1 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Description</span>
                <SearchableSelect
                  value={description}
                  onChange={setDescription}
                  options={descOptions}
                  placeholder="Select or type…"
                  allowNewValue
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Amount (Rp) <span className="text-brand">*</span></span>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={saving}
                  placeholder="0"
                  className={INPUT_CLASS}
                  autoFocus
                />
                <AmountSignHint value={amount} />
              </label>
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={saving || !canSubmit} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
                {saving ? "Saving…" : "Add"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}
