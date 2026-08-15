"use client"

import { useEffect, useState } from "react"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import EventSelect from "@/components/EventSelect"
import { displayIg } from "@/lib/format"
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
            <div>
              <div className="text-sm text-foreground">{displayIg(r.customerHandle)} — {r.productName} × {r.qty}</div>
              {r.note && <div className="text-xs text-gray-400">{r.note}</div>}
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setConvertingId(r.id)} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs">Convert</button>
              <button onClick={() => setRejectingId(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Reject</button>
            </div>
          </div>
        ))
      )}
      {convertingId != null && (
        <ConvertModal
          requestId={convertingId}
          events={options?.activeEvents ?? []}
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

function ConvertModal({ requestId, events, onClose, onDone }: {
  requestId: number
  events: string[]
  onClose: () => void
  onDone: () => void
}) {
  const [event, setEvent] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  async function submit() {
    if (!event) { setError("Pick an event"); return }
    setSubmitting(true); setError("")
    try {
      const res = await fetch(`/api/sheets/order-requests/${requestId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "convert", event }),
      })
      const data = await res.json()
      // 409 = someone else already converted/rejected this request (guard
      // violation in lib/db/catalogue-requests.ts) — a real possibility since
      // two staff can work the queue at once. Surface the message rather than
      // treating it like an unexpected server error.
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
