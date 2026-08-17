"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"

interface Slot {
  id: number
  point: { x: number; y: number } | null
  size: string
  label: string
  claimed: number
  bought: number
  productId: number | null
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

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>

  const needsReview = data.claims.filter((c) => c.state === "review")

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/wa-posts" className="text-sm text-gray-500 hover:text-foreground">
          ←
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-foreground truncate">
            {data.post.store || "Untitled shelf"}
          </h1>
          <p className="text-xs text-gray-500">
            {data.post.event} · {data.slots.length} SKU · {data.post.pricingMethod}
          </p>
        </div>
      </div>

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
          // eslint-disable-next-line @next/next/no-img-element -- our own crop route.
          <img
            src={`/api/whatsapp/slots/${slot.id}/thumb`}
            alt="Close-up of this item on the shelf"
            className="w-28 h-28 rounded-lg border border-cream-border object-cover shrink-0"
          />
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
        <p className="text-xs text-green-700 font-semibold">Named · product #{slot.productId}</p>
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
    </div>
  )
}
