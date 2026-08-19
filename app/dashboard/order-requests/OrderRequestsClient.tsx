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
  const [countries, setCountries] = useState<{ id: number; name: string; kurs: number; cargoPerKg: number }[]>([])

  useEffect(() => {
    fetch("/api/sheets/products", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setCountries(data.countries ?? []))
      .catch(() => {})
  }, [])

  const [convertingId, setConvertingId] = useState<number | null>(null)
  const [rejectingId, setRejectingId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [creatingProductForId, setCreatingProductForId] = useState<number | null>(null)
  const [selectedCandidate, setSelectedCandidate] = useState<Record<number, number>>({}) // requestId -> sendCodeId
  const [resolvingId, setResolvingId] = useState<number | null>(null)
  // Default view is pending-only (matches the API's default). Toggling shows
  // converted/rejected rows too — including WhatsApp closed-trip dead rows,
  // which never show up otherwise.
  const [showAll, setShowAll] = useState(false)

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/sheets/order-requests${showAll ? "?all=true" : ""}`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to load")
      setRequests(data.requests ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [showAll])

  async function cancelEdit(id: number) {
    try {
      const res = await fetch(`/api/sheets/order-requests/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel-edit" }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel edit")
    }
  }

  async function resolveCandidate(r: CatalogueRequest) {
    const sendCodeId = selectedCandidate[r.id] ?? (r.candidates?.length === 1 ? r.candidates[0].id : undefined)
    if (sendCodeId === undefined) return
    setResolvingId(r.id)
    try {
      const res = await fetch(`/api/sheets/order-requests/${r.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve-candidate", sendCodeId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve")
    } finally {
      setResolvingId(null)
    }
  }

  const converting = requests.find((r) => r.id === convertingId) ?? null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <button
          onClick={() => setShowAll((s) => !s)}
          className={`px-3 py-1.5 rounded-lg border text-xs ${
            showAll ? "border-brand bg-brand/5 text-brand" : "border-cream-border text-gray-500"
          }`}
        >
          {showAll ? "Showing all" : "Show all"}
        </button>
      </div>
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="text-sm text-gray-400">No pending requests.</p>
      ) : (
        requests.map((r) => {
          // The only 'rejected'+'whatsapp' rows with productId still null are
          // createRejectedClaim's closed-trip dead rows (case D) — an
          // owner-rejected WhatsApp direct claim already has productId set
          // from the claim, so this doesn't misclassify a normal Tolak.
          const isDeadRow = r.status === "rejected" && r.source === "whatsapp" && r.productId === null
          return (
          <div
            key={r.id}
            className={`rounded-xl border border-cream-border p-3 flex items-center justify-between gap-3 ${
              isDeadRow ? "opacity-60 bg-gray-50" : "bg-white"
            }`}
          >
            <div className="flex items-center gap-3">
              {r.referenceImageUrl && (
                <a href={r.referenceImageUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
                  <img src={r.referenceImageUrl} alt="" className="w-10 h-10 rounded-lg object-cover border border-cream-border" />
                </a>
              )}
              <div>
                <div className="text-sm text-foreground">
                  {r.source === "whatsapp" && (
                    <span className="inline-block px-1.5 py-0.5 rounded bg-green-100 text-green-700 text-[10px] font-medium mr-1 align-middle">WhatsApp</span>
                  )}
                  {displayIg(r.customerHandle)} —{" "}
                  {r.status === "asking" ? (
                    <>× {r.qty}</>
                  ) : r.productId === null ? (
                    <>
                      <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-medium mr-1 align-middle">Custom</span>
                      {r.description} × {r.qty}
                    </>
                  ) : (
                    <>{r.productName} × {r.qty}</>
                  )}
                </div>
                {r.note && <div className="text-xs text-gray-400">{r.note}</div>}
              </div>
            </div>
            <div className="flex gap-2 shrink-0 items-center">
              {r.status === "pending" && (
                <>
                  <button onClick={() => setConvertingId(r.id)} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs">Convert</button>
                  <button onClick={() => setRejectingId(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Reject</button>
                  {r.productId === null && (
                    <button onClick={() => setEditingId(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Edit</button>
                  )}
                </>
              )}
              {r.status === "offer_pending" && (
                <>
                  <span className="text-xs text-amber-600 font-medium">
                    Menunggu persetujuan customer — {r.countryName} · valas {r.valas} · {r.gram}g · Rp {fmt(r.estimatedPrice ?? 0)}
                  </span>
                  <button onClick={() => cancelEdit(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Cancel</button>
                </>
              )}
              {r.status === "approved" && (
                <>
                  <span className="text-xs text-green-600 font-medium">
                    Customer approved ✓ — {r.countryName} · valas {r.valas} · {r.gram}g · Rp {fmt(r.estimatedPrice ?? 0)}
                  </span>
                  <button onClick={() => setCreatingProductForId(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Create Product</button>
                  <button onClick={() => setConvertingId(r.id)} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs">Convert</button>
                  <button onClick={() => setRejectingId(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Reject</button>
                </>
              )}
              {r.status === "asking" && (
                <div className="flex flex-col gap-2 w-full">
                  <span className="text-xs text-amber-600 font-medium">
                    {r.candidates && r.candidates.length === 1 ? "Ditanya di grup — menunggu 👍" : "Ditanya di grup — beberapa kemungkinan"}
                  </span>
                  <div className="flex flex-col gap-1">
                    {(r.candidates ?? []).map((c, i) => {
                      const isSelected = selectedCandidate[r.id] === c.id || (r.candidates!.length === 1 && selectedCandidate[r.id] === undefined && i === 0)
                      return (
                        <label
                          key={c.id}
                          className={`flex items-center gap-2 border rounded-lg px-2 py-1.5 text-xs cursor-pointer ${isSelected ? "border-brand ring-1 ring-brand" : "border-cream-border"}`}
                        >
                          <input
                            type="radio"
                            name={`candidate-${r.id}`}
                            checked={isSelected}
                            onChange={() => setSelectedCandidate((s) => ({ ...s, [r.id]: c.id }))}
                            className="accent-brand"
                          />
                          <span className="font-mono font-bold text-brand">{c.code}</span>
                          <span>{c.productName}</span>
                          <span className="ml-auto text-gray-500">Rp {c.price.toLocaleString("id-ID")}</span>
                        </label>
                      )
                    })}
                  </div>
                  <button
                    disabled={resolvingId === r.id || (r.candidates?.length !== 1 && selectedCandidate[r.id] === undefined)}
                    onClick={() => resolveCandidate(r)}
                    className="self-start px-3 py-1.5 rounded-lg bg-brand text-white text-xs disabled:opacity-50"
                  >
                    {resolvingId === r.id ? "Menyimpan…" : "Pilih"}
                  </button>
                </div>
              )}
              {isDeadRow && (
                <span className="text-xs text-gray-400">Trip sudah tutup — tidak dicatat</span>
              )}
            </div>
          </div>
          )
        })
      )}
      {converting && (
        <ConvertModal
          requestId={converting.id}
          needsProduct={converting.productId === null}
          events={options?.activeEvents ?? []}
          items={options?.items ?? []}
          defaultEvent={converting.defaultEvent}
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
      {editingId != null && (
        <EditModal
          requestId={editingId}
          countries={countries}
          onClose={() => setEditingId(null)}
          onDone={() => { setEditingId(null); reload() }}
        />
      )}
      {creatingProductForId != null && (() => {
        const req = requests.find((r) => r.id === creatingProductForId)
        return req ? (
          <CreateProductModal
            request={req}
            countries={countries}
            onClose={() => setCreatingProductForId(null)}
            onDone={() => setCreatingProductForId(null)}
          />
        ) : null
      })()}
    </div>
  )
}

function ConvertModal({ requestId, needsProduct, events, items, defaultEvent, onClose, onDone }: {
  requestId: number
  needsProduct: boolean
  events: string[]
  items: { id: number; name: string; store: string; price: number; active: boolean }[]
  defaultEvent: string | null
  onClose: () => void
  onDone: () => void
}) {
  const [event, setEvent] = useState(() => (defaultEvent && events.includes(defaultEvent)) ? defaultEvent : "")
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

function EditModal({ requestId, countries, onClose, onDone }: {
  requestId: number
  countries: { id: number; name: string }[]
  onClose: () => void
  onDone: () => void
}) {
  const [countryId, setCountryId] = useState("")
  const [valas, setValas] = useState("")
  const [gram, setGram] = useState("")
  const [preview, setPreview] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  const countryOptions = useMemo(
    () => countries.map((c) => ({ value: String(c.id), label: c.name })),
    [countries],
  )

  useEffect(() => {
    const cId = Number(countryId)
    const v = Number(valas)
    const g = Number(gram)
    if (!cId || !(v > 0) || !(g > 0)) { setPreview(null); return }
    const t = setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const res = await fetch(`/api/sheets/order-requests/preview-price?countryId=${cId}&valas=${v}&gram=${g}`)
        const data = await res.json()
        setPreview(res.ok ? data.estimatedPrice : null)
      } catch {
        setPreview(null)
      } finally {
        setPreviewLoading(false)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [countryId, valas, gram])

  async function submit() {
    if (!countryId) { setError("Pick a country"); return }
    if (!(Number(valas) > 0)) { setError("Enter a valid valas amount"); return }
    if (!(Number(gram) > 0)) { setError("Enter a valid weight"); return }
    setSubmitting(true); setError("")
    try {
      const res = await fetch(`/api/sheets/order-requests/${requestId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit", countryId: Number(countryId), valas: Number(valas), gram: Number(gram) }),
      })
      const data = await res.json()
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
        <h3 className="text-sm font-semibold text-foreground">Propose a price revision</h3>
        <SearchableSelect value={countryId} onChange={setCountryId} options={countryOptions} placeholder="Country…" />
        <input value={valas} onChange={(e) => setValas(e.target.value)} placeholder="Valas amount" type="number" min="0" step="any" className="border border-cream-border rounded-lg px-2 py-1.5 text-sm" />
        <input value={gram} onChange={(e) => setGram(e.target.value)} placeholder="Weight (gram)" type="number" min="0" step="any" className="border border-cream-border rounded-lg px-2 py-1.5 text-sm" />
        <p className="text-xs text-gray-500">
          {previewLoading ? "Calculating…" : preview != null ? `Estimated price: Rp ${fmt(preview)}` : "—"}
        </p>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Send to customer"}
          </button>
        </div>
      </div>
    </div>
  )
}

function CreateProductModal({ request, countries, onClose, onDone }: {
  request: CatalogueRequest
  countries: { id: number; name: string; kurs: number; cargoPerKg: number }[]
  onClose: () => void
  onDone: () => void
}) {
  const [name, setName] = useState(request.description)
  const [price, setPrice] = useState(String(request.estimatedPrice ?? 0))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  const country = countries.find((c) => c.id === request.countryId)

  async function submit() {
    if (!name.trim()) { setError("Name is required"); return }
    if (!(Number(price) > 0)) { setError("Enter a valid price"); return }
    setSubmitting(true); setError("")
    try {
      const res = await fetch("/api/sheets/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          store: "",
          pricingMethod: "overseas",
          countryId: request.countryId,
          valas: request.valas,
          gram: request.gram,
          // Stored so the row's OTHER fields stay internally consistent
          // with what actually produced `price` below — otherwise the row
          // shows kurs/cargoPerKg as 0 and a later Products-page edit
          // recomputes the price from freight only. Does NOT affect the
          // price itself, which is still whatever's in `price` below.
          kurs: country?.kurs ?? 0,
          cargoPerKg: country?.cargoPerKg ?? 0,
          profitPct: 15,
          operationalFee: 0,
          packingFee: 0,
          // Locked to exactly what the customer approved — not recomputed
          // from the country's live kurs, which may have moved since. See
          // this plan's Global Constraints and the spec's "Owner
          // Experience" section.
          price: Number(price),
        }),
      })
      const data = await res.json()
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
        <h3 className="text-sm font-semibold text-foreground">Create product from approved offer</h3>
        <p className="text-xs text-gray-500">
          {request.countryName} · valas {request.valas} · {request.gram}g
        </p>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Product name" className="border border-cream-border rounded-lg px-2 py-1.5 text-sm" />
        <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Price" type="number" min="0" className="border border-cream-border rounded-lg px-2 py-1.5 text-sm" />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  )
}
