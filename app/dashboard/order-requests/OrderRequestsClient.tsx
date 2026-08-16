"use client"

import { useEffect, useMemo, useState } from "react"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import EventSelect from "@/components/EventSelect"
import SearchableSelect from "@/components/SearchableSelect"
import { displayIg, fmt } from "@/lib/format"
import type { CatalogueRequest } from "@/lib/db"

export default function OrderRequestsClient() {
  const options = useSheetOptions()
  const [requests, setRequests] = useState<CatalogueRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [convertingId, setConvertingId] = useState<number | null>(null)
  const [rejectingId, setRejectingId] = useState<number | null>(null)

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/order-requests", { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to load")
      setRequests(data.requests ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [])

  const converting = requests.find((r) => r.id === convertingId) ?? null

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="text-sm text-gray-400">No pending requests.</p>
      ) : (
        requests.map((r) => (
          <div key={r.id} className="rounded-xl border border-cream-border bg-white p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {r.referenceImageUrl && (
                <a href={r.referenceImageUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
                  <img src={r.referenceImageUrl} alt="" className="w-10 h-10 rounded-lg object-cover border border-cream-border" />
                </a>
              )}
              <div>
                <div className="text-sm text-foreground">
                  {displayIg(r.customerHandle)} —{" "}
                  {r.productName ? (
                    <>{r.productName} × {r.qty}</>
                  ) : (
                    <>
                      <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-medium mr-1 align-middle">Custom</span>
                      {r.description} × {r.qty}
                    </>
                  )}
                </div>
                {r.note && <div className="text-xs text-gray-400">{r.note}</div>}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setConvertingId(r.id)} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs">Convert</button>
              <button onClick={() => setRejectingId(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Reject</button>
            </div>
          </div>
        ))
      )}
      {converting && (
        <ConvertModal
          requestId={converting.id}
          needsProduct={converting.productId === null}
          events={options?.activeEvents ?? []}
          items={options?.items ?? []}
          onClose={() => setConvertingId(null)}
          onDone={() => { setConvertingId(null); reload() }}
        />
      )}
      {rejectingId != null && (
        <RejectModal
          requestId={rejectingId}
          onClose={() => setRejectingId(null)}
          onDone={() => { setRejectingId(null); reload() }}
        />
      )}
    </div>
  )
}

function ConvertModal({ requestId, needsProduct, events, items, onClose, onDone }: {
  requestId: number
  needsProduct: boolean
  events: string[]
  items: { id: number; name: string; store: string; price: number; active: boolean }[]
  onClose: () => void
  onDone: () => void
}) {
  const [event, setEvent] = useState("")
  const [productId, setProductId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  const itemOptions = useMemo(
    () => items.filter((it) => it.active).map((it) => ({
      value: String(it.id),
      label: it.name,
      meta: `Rp ${fmt(it.price)}`,
    })),
    [items],
  )

  async function submit() {
    if (!event) { setError("Pick an event"); return }
    if (needsProduct && !productId) { setError("Pick a product for this custom request"); return }
    setSubmitting(true); setError("")
    try {
      const res = await fetch(`/api/sheets/order-requests/${requestId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "convert",
          event,
          ...(needsProduct ? { productId: Number(productId) } : {}),
        }),
      })
      const data = await res.json()
      // 409 = someone else already converted/rejected this request (guard
      // violation); 400 = validation problem (missing event, or a custom
      // request converted without picking a product). Surfaced identically
      // via the same error message, both are user-actionable, not crashes.
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-sm flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">Convert to order</h3>
        <EventSelect value={event} onChange={setEvent} events={events} placeholder="Select event…" />
        {needsProduct && (
          <SearchableSelect
            value={productId}
            onChange={setProductId}
            options={itemOptions}
            placeholder="Search product for this custom request…"
          />
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Convert"}
          </button>
        </div>
      </div>
    </div>
  )
}

function RejectModal({ requestId, onClose, onDone }: {
  requestId: number
  onClose: () => void
  onDone: () => void
}) {
  const [staffNote, setStaffNote] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  async function submit() {
    setSubmitting(true); setError("")
    try {
      const res = await fetch(`/api/sheets/order-requests/${requestId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", staffNote }),
      })
      const data = await res.json()
      // Same 409-on-guard-violation handling as ConvertModal above.
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-sm flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">Reject request</h3>
        <input
          value={staffNote}
          onChange={(e) => setStaffNote(e.target.value)}
          placeholder="Note the customer will see (optional)"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  )
}
