"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { PRICING_METHODS, PRICING_METHOD_LABEL, type PricingMethod } from "@/lib/pricing"
import { fmt, senderDigits, claimedAt } from "@/lib/format"

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
  createdAt: string
}

interface Payload {
  post: {
    id: number
    event: string
    store: string
    /** Null while the post is still following the WhatsApp setting. */
    pricingMethod: PricingMethod | null
    /** What that amounts to right now, so the option can be named. */
    effectivePricingMethod: PricingMethod
    countryId: number | null
  }
  slots: Slot[]
  claims: Claim[]
}

/** Just enough of a neighbouring shelf to link to it. */
interface Sibling {
  id: number
  store: string
}

interface Siblings {
  previous: Sibling | null
  next: Sibling | null
  position: number
  total: number
}

export default function PostReviewClient({ postId }: { postId: number }) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState("")
  const [version, setVersion] = useState(0)
  const [siblings, setSiblings] = useState<Siblings | null>(null)

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

  // The rest of this shop's shelves, so naming can walk the trip the way the
  // shopping did. Asked for by store rather than by page: which page of the
  // archive a shelf falls on is an accident of how many were posted since.
  const store = data?.post.store ?? ""
  useEffect(() => {
    if (!store) return
    const params = new URLSearchParams({ store, page: "1", pageSize: "200" })
    fetch(`/api/whatsapp/posts?${params}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: { rows?: Sibling[] }) => {
        // The archive answers newest-first; a walk goes the other way, in the
        // order the racks were photographed.
        const walk = [...(payload.rows ?? [])].sort((a, b) => a.id - b.id)
        const index = walk.findIndex((p) => p.id === postId)
        if (index === -1) return setSiblings(null)
        setSiblings({
          previous: index > 0 ? walk[index - 1] : null,
          next: index < walk.length - 1 ? walk[index + 1] : null,
          position: index + 1,
          total: walk.length,
        })
      })
      .catch(() => setSiblings(null))
  }, [store, postId])

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
  const claimed = data.slots.reduce((n, s) => n + s.claimed, 0)
  const bought = data.slots.reduce((n, s) => n + s.bought, 0)

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
          <p className="text-xs text-gray-500 tabular-nums">
            {data.post.event} · {data.slots.length} SKU · {bought} of {claimed} units
          </p>
        </div>

        {/* Normally left on Default, which follows Settings → WhatsApp, so
            changing that setting moves every shelf that has not been named yet.
            Picking a method here opts this one shelf out — for a store priced
            differently from the rest of the trip. Naming pins whatever was in
            force, because from then on it is a price customers have been
            quoted. */}
        <label className="flex items-center gap-2 text-xs text-gray-500 shrink-0">
          Pricing
          <select
            value={data.post.pricingMethod ?? ""}
            onChange={(e) => setPricingMethod(e.target.value)}
            className="border border-cream-border rounded-lg px-2 py-1.5 text-sm bg-white"
          >
            <option value="">
              Default · {PRICING_METHOD_LABEL[data.post.effectivePricingMethod]}
            </option>
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
            needsPrice={
              (data.post.pricingMethod ?? data.post.effectivePricingMethod) === "target_price"
            }
            onDone={refresh}
          />
        ))}
      </div>

      {/* The racks either side, in the order the shop was photographed — the
          same walk Group Order takes, so a shelf missed at the hotel is reached
          the same way it was reached in the shop. */}
      {siblings && siblings.total > 1 ? (
        <div className="flex items-center gap-2">
          <NeighbourLink post={siblings.previous} direction="previous" />
          <span className="text-xs text-gray-500 tabular-nums shrink-0">
            {siblings.position} of {siblings.total}
          </span>
          <NeighbourLink post={siblings.next} direction="next" />
        </div>
      ) : null}
    </div>
  )
}

/**
 * One step along the aisle, or a dead end held open.
 *
 * The disabled end keeps its space rather than collapsing, so the button under
 * a cursor does not move between shelves.
 */
function NeighbourLink({
  post, direction,
}: {
  post: Sibling | null
  direction: "previous" | "next"
}) {
  const label = direction === "next" ? "Next shelf →" : "← Previous shelf"
  const shared =
    "flex-1 rounded-xl border border-cream-border px-4 py-2.5 text-sm font-semibold text-center"

  if (post === null) {
    return <span className={`${shared} text-gray-300 bg-cream/50`}>{label}</span>
  }
  return (
    <Link href={`/dashboard/wa-posts/${post.id}`} className={`${shared} bg-white hover:border-brand`}>
      {label}
    </Link>
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
          <span className="text-xs font-mono text-gray-600 shrink-0">
            {senderDigits(claim.sender)}
            <span className="text-gray-400"> · {claimedAt(claim.createdAt)}</span>
          </span>
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
function SlotCard({
  slot, claims, needsPrice, onDone,
}: {
  slot: Slot
  claims: Claim[]
  /** Target Price is the one method whose price a human decides. */
  needsPrice: boolean
  onDone: () => void
}) {
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
    <div className="rounded-xl border border-cream-border bg-white p-3">
      {/* The thumbnail is a fixed column and everything else flows beside it.
          Stacked instead, a short card left a tall blank to the right of the
          picture. */}
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

        <div className="min-w-0 flex-1 flex flex-col gap-2">
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
            <p className="text-xs text-amber-700">
              No position on the photo — place it before naming.
            </p>
          ) : null}

          <div className="flex flex-col gap-1">
            {claims.map((claim) => (
              <div key={claim.id} className="flex items-start gap-2 text-xs">
                <span className="flex-1 min-w-0">
                  <span className="block truncate">
                    {claim.customer ?? (
                      <span className="text-amber-700">{senderDigits(claim.sender)}</span>
                    )}
                    {claim.note ? <span className="text-gray-500"> · “{claim.note}”</span> : null}
                  </span>
                  <span className="block text-gray-400 tabular-nums">
                    {senderDigits(claim.sender)} · {claimedAt(claim.createdAt)}
                  </span>
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
                {/* Only where the method has no formula to derive a price from.
                    Every other method computes one from the valas, the kurs and
                    the weight, so the box was a permanent invitation to type a
                    number that would be ignored. */}
                {needsPrice ? (
                  <input
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    inputMode="numeric"
                    placeholder="Harga jual (Target Price)"
                    className="col-span-2 border border-cream-border rounded-lg px-2 py-1.5 text-sm"
                  />
                ) : null}
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
      </div>

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
      {/* The controls sit on the picture rather than under it: at the closest
          step the crop is small, and buttons in a row below it put the thing you
          are reading and the thing you are pressing a long way apart. */}
      {/* A fixed width, not the image's. A tighter crop is a smaller file — the
          route serves the pixels that exist rather than enlarging them — so
          sizing the panel to its content made the whole thing shrink as you
          looked closer, moving the buttons under your cursor. */}
      <div
        className="relative w-[min(90vw,640px)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- our own crop route. */}
        <img
          src={`/api/whatsapp/slots/${slotId}/thumb?share=${share}`}
          alt="Close-up of this item on the shelf"
          className="w-full rounded-xl bg-black"
        />

        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-2 right-2 w-9 h-9 rounded-full bg-black/60 text-white flex items-center justify-center"
        >
          <svg
            width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round"
          >
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full bg-black/60 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setStep((n) => Math.max(0, n - 1))}
            disabled={step === 0}
            aria-label="Show more of the shelf"
            className="w-8 h-8 rounded-full text-white flex items-center justify-center disabled:opacity-30"
          >
            <svg
              width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="20" y1="20" x2="16.65" y2="16.65" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          {/* How much closer than the widest step, rather than which step of
              four: "2.2×" says what you are looking at, "3/4" says where you are
              in a list nobody knew existed. */}
          <span className="text-[11px] text-white/80 tabular-nums">
            {(ZOOM_STEPS[0] / share).toFixed(1)}×
          </span>
          <button
            type="button"
            onClick={() => setStep((n) => Math.min(ZOOM_STEPS.length - 1, n + 1))}
            disabled={step === ZOOM_STEPS.length - 1}
            aria-label="Look closer"
            className="w-8 h-8 rounded-full text-white flex items-center justify-center disabled:opacity-30"
          >
            <svg
              width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="20" y1="20" x2="16.65" y2="16.65" />
              <line x1="8" y1="11" x2="14" y2="11" />
              <line x1="11" y1="8" x2="11" y2="14" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
