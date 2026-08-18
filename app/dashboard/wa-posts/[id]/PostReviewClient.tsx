"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { PRICING_METHODS, PRICING_METHOD_LABEL, type PricingMethod } from "@/lib/pricing"
import { fmt, senderDigits, claimedAt } from "@/lib/format"
import SlotZoom from "@/components/SlotZoom"
import SlotNameForm from "@/components/SlotNameForm"

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
  productValas: number | null
  productGram: number | null
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
    /** What the price tag is written in, for the naming fields. */
    currency: string
    countryId: number | null
  }
  slots: Slot[]
  claims: Claim[]
  /** Claims on a named slot that have no order — see addMissingOrders. */
  unordered: number[]
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
            unordered={new Set(data.unordered ?? [])}
            currency={data.post.currency}
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
  slot, claims, unordered, currency, needsPrice, onDone,
}: {
  slot: Slot
  claims: Claim[]
  /** Ids of claims on this slot with no order yet. */
  unordered: Set<number>
  currency: string
  /** Target Price is the one method whose price a human decides. */
  needsPrice: boolean
  onDone: () => void
}) {
  const [zoom, setZoom] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  // Claims here that reached the tally but no invoice. Shown rather than
  // guessed at: a button offered unconditionally says nothing about whether
  // anything is actually missing.
  const missing = claims.filter((c) => unordered.has(c.id))

  /** Give those claims their lines, at the price this slot already has. */
  async function addOrders() {
    setBusy(true)
    setError("")
    const res = await fetch(`/api/whatsapp/slots/${slot.id}/orders`, { method: "POST" })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to add orders" }))
      setError(body.error ?? "Failed to add orders")
      return
    }
    onDone()
  }

  const blocked = claims.some((c) => c.customer === null)

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
                {slot.productId !== null && unordered.has(claim.id) ? (
                  <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                    belum ada order
                  </span>
                ) : null}
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
                {claims.length - missing.length}{" "}
                {claims.length - missing.length === 1 ? "order" : "orders"}
                {missing.length > 0
                  ? ` · ${missing.length} claim${missing.length === 1 ? "" : "s"} without one`
                  : ""}{" "}
                · product #{slot.productId}
              </div>

              {/* Only when there is a gap. A button that is always there says
                  nothing about whether anything is missing, so it has to be
                  pressed to find out — and the answer is usually no. */}
              {missing.length > 0 ? (
                <>
                  <button
                    type="button"
                    onClick={addOrders}
                    disabled={busy}
                    className="mt-2 w-full rounded-lg border border-amber-300 bg-white py-1.5 text-[11px] font-bold text-amber-800 disabled:opacity-40"
                  >
                    {busy
                      ? "Adding…"
                      : `Buat ${missing.length} order lagi${
                          slot.productPrice !== null ? ` · Rp ${fmt(slot.productPrice)}` : ""
                        }`}
                  </button>
                  {error ? <p className="text-[11px] text-red-600 mt-1">{error}</p> : null}
                </>
              ) : null}

            </div>
          ) : (
            <>
              {/* The form reports its own failures; the card has none of its own
                  left to report. */}
              <SlotNameForm
                slotId={slot.id}
                defaultName={slot.label}
                currency={currency}
                needsPrice={needsPrice}
                blocked={blocked}
                onNamed={onDone}
              />
            </>
          )}
        </div>
      </div>

      {zoom ? (
        <SlotZoom
          slotId={slot.id}
          onClose={() => setZoom(false)}
          // The name it was given and what it sells for. Both are being checked
          // against the tag on screen, so both belong in the heading rather than
          // on the card behind the picture.
          caption={[
            slot.productName || slot.label || `SKU ${slot.id}`,
            slot.size || null,
            slot.productPrice !== null ? `Rp ${fmt(slot.productPrice)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          // Only where there is still something to name. A slot that already
          // became a product wants the late-orders button on the card, not a
          // second form that would refuse.
          // Present whether or not the slot is named: unnamed it is the form,
          // named it is the record — with the orders button live if somebody on
          // this slot still has none.
          form={
            <SlotNameForm
              slotId={slot.id}
              defaultName={slot.productName ?? slot.label}
              defaultValas={slot.productValas}
              defaultGram={slot.productGram}
              named={slot.productId !== null}
              missing={missing.length}
              currency={currency}
              needsPrice={needsPrice}
              blocked={blocked}
              onNamed={() => {
                setZoom(false)
                onDone()
              }}
              compact
            />
          }
        />
      ) : null}
    </div>
  )
}

