"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { PRICING_METHODS, PRICING_METHOD_LABEL } from "@/lib/pricing"
import { fmt } from "@/lib/format"

interface Slot {
  id: number
  point: { x: number; y: number } | null
  size: string
  label: string
  claimed: number
  bought: number
  productId: number | null
  productName: string | null
  productPrice: number | null
}

interface Claim {
  id: number
  slotId: number | null
  customer: string | null
  sender: string
  quantity: number
  obtained: number
  note: string
  state: string
  confidence: number
}

interface Payload {
  post: {
    id: number
    event: string
    store: string
    pricingMethod: string
    countryId: number | null
  }
  slots: Slot[]
  claims: Claim[]
}

export default function PostReviewClient({ postId }: { postId: number }) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState("")
  const [version, setVersion] = useState(0)

  const load = useCallback(() => {
    fetch(`/api/whatsapp/posts/${postId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: Payload & { error?: string }) => {
        if (payload.error) setError(payload.error)
        else setData(payload)
      })
      .catch(() => setError("Failed to load"))
  }, [postId])

  useEffect(load, [load])

  function refresh() {
    setVersion((v) => v + 1)
    load()
  }

  async function setPricingMethod(pricingMethod: string) {
    await fetch(`/api/whatsapp/posts/${postId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pricingMethod }),
    })
    load()
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>

  const needsReview = data.claims.filter((c) => c.state === "review")
  const namedCount = data.slots.filter((s) => s.productId !== null).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/wa-posts" className="text-sm text-gray-500 hover:text-foreground">
          ←
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold text-foreground truncate">
            {data.post.store || "Untitled shelf"}
          </h1>
          <p className="text-xs text-gray-500">
            {data.post.event} · {data.slots.length} SKU
          </p>
        </div>

        {/* A post keeps the pricing method it was captured with, so changing the
            WhatsApp default later does not reach back and reprice a morning's
            shelves. A shelf cannot be re-posted, though, so a wrong one has to
            be correctable here. */}
        <label className="flex items-center gap-2 text-xs text-gray-500 shrink-0">
          Pricing
          <select
            value={data.post.pricingMethod}
            onChange={(e) => setPricingMethod(e.target.value)}
            className="border border-cream-border rounded-lg px-2 py-1.5 text-sm bg-white"
          >
            {PRICING_METHODS.map((method) => (
              <option key={method} value={method}>
                {PRICING_METHOD_LABEL[method]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {namedCount > 0 ? (
        <p className="text-xs text-gray-500">
          {namedCount} SKU already named keep the price they were created with —
          changing the method here only affects the ones still to be named.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start">
        {/* eslint-disable-next-line @next/next/no-img-element -- our own rendered JPEG. */}
        <img
          src={`/api/whatsapp/posts/${postId}/rekap?v=${version}`}
          alt="The shelf with a badge on each SKU"
          className="w-full rounded-xl border border-cream-border"
        />

        <div className="flex flex-col gap-4">
          {needsReview.length > 0 ? <ReviewQueue claims={needsReview} onDone={refresh} /> : null}

          {data.slots.map((slot) => (
            <SlotCard
              key={slot.id}
              slot={slot}
              claims={data.claims.filter((c) => c.slotId === slot.id && c.state !== "rejected")}
              onDone={refresh}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Claims that need a human before they can become anything.
 *
 * Almost always an unrecognised number. Naming refuses while one of these sits
 * under a slot, because creating the product and silently dropping that
 * person's order would be worse than stopping.
 */
function ReviewQueue({ claims, onDone }: { claims: Claim[]; onDone: () => void }) {
  const [handles, setHandles] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function link(claim: Claim) {
    const handle = (handles[claim.id] ?? "").trim()
    if (!handle) return
    setBusy(true)
    setError("")
    const res = await fetch(`/api/whatsapp/claims/${claim.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer: handle }),
    })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to link" }))
      setError(body.error ?? "Failed to link")
      return
    }
    onDone()
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">
        {claims.length} {claims.length === 1 ? "claim needs" : "claims need"} you
      </h2>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      {claims.map((claim) => (
        <div key={claim.id} className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-600 shrink-0">{claim.sender}</span>
          <input
            value={handles[claim.id] ?? ""}
            onChange={(e) => setHandles((h) => ({ ...h, [claim.id]: e.target.value }))}
            placeholder="instagram handle"
            className="flex-1 min-w-0 border border-cream-border rounded-lg px-2 py-1 text-xs bg-white"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => link(claim)}
            className="rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-40"
          >
            Link
          </button>
        </div>
      ))}
      <p className="text-[11px] text-gray-600">
        Linking writes the number onto that customer, so the same person is never
        asked twice.
      </p>
    </div>
  )
}

/** One SKU: who wants it, and the form that turns it into a product. */
function SlotCard({ slot, claims, onDone }: { slot: Slot; claims: Claim[]; onDone: () => void }) {
  const [name, setName] = useState(slot.label)
  const [valas, setValas] = useState("")
  const [gram, setGram] = useState("")
  const [price, setPrice] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [zoom, setZoom] = useState(false)

  const blocked = claims.some((c) => c.customer === null)

  async function create() {
    setBusy(true)
    setError("")
    const res = await fetch(`/api/whatsapp/slots/${slot.id}/name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        valas: Number(valas) || 0,
        gram: Number(gram) || 0,
        ...(price ? { price: Number(price) } : {}),
      }),
    })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to name" }))
      setError(body.error ?? "Failed to name")
      return
    }
    onDone()
  }

  return (
    <div className="rounded-xl border border-cream-border bg-white p-3 flex flex-col gap-2">
      <div className="flex items-start gap-3">
        {/* The photograph underneath, uncovered. The shopping list draws a badge
            over each slot so the count reads at arm's length in a shop; here
            that badge would sit on top of the product being named. */}
        {slot.point ? (
          <button
            type="button"
            onClick={() => setZoom(true)}
            className="shrink-0 rounded-lg overflow-hidden border border-cream-border hover:border-brand transition-colors"
            title="Look closer"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- our own crop route. */}
            <img
              src={`/api/whatsapp/slots/${slot.id}/thumb`}
              alt="Close-up of this item on the shelf"
              className="w-28 h-28 object-cover"
            />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold text-foreground truncate">
              {slot.label || `SKU ${slot.id}`}
              {slot.size ? <span className="text-gray-500 font-normal"> · {slot.size}</span> : null}
            </h3>
            <span className="text-xs text-gray-500 tabular-nums ml-auto shrink-0">
              {slot.bought} of {slot.claimed} bought
            </span>
          </div>
          {!slot.point ? (
            <p className="text-xs text-amber-700 mt-1">
              No position on the photo — place it before naming.
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        {claims.map((claim) => (
          <div key={claim.id} className="flex items-center gap-2 text-xs">
            <span className="flex-1 min-w-0 truncate">
              {claim.customer ?? <span className="text-amber-700">{claim.sender}</span>}
              {claim.note ? <span className="text-gray-500"> · “{claim.note}”</span> : null}
            </span>
            <span className="text-gray-500 tabular-nums shrink-0">
              {claim.obtained}/{claim.quantity}
            </span>
          </div>
        ))}
      </div>

      {slot.productId !== null ? (
        // What was actually created, not just that something was. The name is
        // the one place a wrong valas or a mistyped size becomes obvious, and
        // it is obvious only while the shelf is still on screen.
        <div className="rounded-lg bg-green-50 border border-green-200 px-2.5 py-2">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-green-900 truncate">
              {slot.productName ?? `Product #${slot.productId}`}
            </span>
            <span className="ml-auto text-sm font-bold text-green-900 tabular-nums shrink-0">
              {slot.productPrice !== null ? `Rp ${fmt(slot.productPrice)}` : "—"}
            </span>
          </div>
          <div className="text-[11px] text-green-800 mt-0.5">
            {claims.length} {claims.length === 1 ? "order" : "orders"} created · product #
            {slot.productId}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Product name"
              className="col-span-2 border border-cream-border rounded-lg px-2 py-1.5 text-sm"
            />
            <input
              value={valas}
              onChange={(e) => setValas(e.target.value)}
              inputMode="decimal"
              placeholder="Valas (price tag)"
              className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
            />
            <input
              value={gram}
              onChange={(e) => setGram(e.target.value)}
              inputMode="numeric"
              placeholder="Gram"
              className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
            />
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="numeric"
              placeholder="Price (Target Price only)"
              className="col-span-2 border border-cream-border rounded-lg px-2 py-1.5 text-sm"
            />
          </div>

          {error ? <p className="text-xs text-red-600">{error}</p> : null}
          {blocked ? (
            <p className="text-xs text-amber-700">
              One of these senders is not a customer yet. Link them above first —
              naming now would drop their order.
            </p>
          ) : null}

          <button
            type="button"
            disabled={busy || blocked || !name.trim()}
            onClick={create}
            className="rounded-lg bg-brand py-1.5 text-xs font-bold text-white disabled:opacity-40"
          >
            Create product and orders
          </button>
        </>
      )}

      {zoom ? <SlotZoom slotId={slot.id} onClose={() => setZoom(false)} /> : null}
    </div>
  )
}

/** How much of the shelf's shorter side each step shows. */
const ZOOM_STEPS = [0.4, 0.28, 0.18, 0.12]

/**
 * A closer look at one slot.
 *
 * Zooming crops tighter rather than enlarging. A price tag is a handful of
 * pixels on a shelf photograph, so blowing up the same crop only makes it
 * blurrier — showing less of the shelf is the only thing that actually reveals
 * more of the label.
 */
function SlotZoom({ slotId, onClose }: { slotId: number; onClose: () => void }) {
  const [step, setStep] = useState(1)
  const share = ZOOM_STEPS[step]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex flex-col gap-2 max-w-[min(90vw,640px)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- our own crop route. */}
        <img
          src={`/api/whatsapp/slots/${slotId}/thumb?share=${share}`}
          alt="Close-up of this item on the shelf"
          className="w-full rounded-xl bg-black"
        />
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setStep((n) => Math.max(0, n - 1))}
            disabled={step === 0}
            className="rounded-lg bg-white/90 px-3 py-1.5 text-sm font-semibold disabled:opacity-40"
          >
            Wider
          </button>
          <span className="text-xs text-white/80 tabular-nums">
            {step + 1} / {ZOOM_STEPS.length}
          </span>
          <button
            type="button"
            onClick={() => setStep((n) => Math.min(ZOOM_STEPS.length - 1, n + 1))}
            disabled={step === ZOOM_STEPS.length - 1}
            className="rounded-lg bg-white/90 px-3 py-1.5 text-sm font-semibold disabled:opacity-40"
          >
            Closer
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-white/90 px-3 py-1.5 text-sm font-semibold"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
