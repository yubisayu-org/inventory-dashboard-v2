"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { fmt, senderDigits, claimedAt } from "@/lib/format"
import { PRICING_METHODS, PRICING_METHOD_LABEL, type PricingMethod } from "@/lib/pricing"
import { alternativeSizes } from "@/lib/claims/size"
import { neighbours, type Neighbours, type ShopPost } from "../stores"
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
  /** What it was named as, once it has been. */
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
  /** Set once a different size has been agreed. Null means the note stands. */
  size: string | null
  state: string
  createdAt: string
}

interface PostPayload {
  post: {
    id: number
    event: string
    store: string
    /** Null while the shelf still follows the WhatsApp setting. */
    pricingMethod: PricingMethod | null
    /** What that amounts to now — and the one field with no formula behind it. */
    effectivePricingMethod: PricingMethod
    /** What the price tag is written in, for the naming fields. */
    currency: string
  }
  slots: Slot[]
  claims: Claim[]
  /** Claims on a named slot with no order yet. */
  unordered: number[]
}

const tone = (claimed: number, bought: number) =>
  bought >= claimed ? "text-green-700" : bought > 0 ? "text-amber-600" : "text-red-700"

export default function ShopPostClient({
  postId, canName,
}: {
  postId: number
  /** Naming creates products and orders — owners only. */
  canName: boolean
}) {
  const [data, setData] = useState<PostPayload | null>(null)
  const [error, setError] = useState("")
  const [openSlot, setOpenSlot] = useState<number | null>(null)
  // The crop, big. Separate from the tally: "which pyjamas are these" and "how
  // many did I find" are different questions, and in a shop the first is asked
  // far more often.
  const [zoomSlot, setZoomSlot] = useState<number | null>(null)
  // The other shelves in this shop, so the next rack is one tap rather than a
  // trip back to the list. Fetched separately because it is a different
  // question — "what else is in this shop" — and a stale answer costs nothing.
  const [siblings, setSiblings] = useState<Neighbours | null>(null)
  // Bumped after every save so the rendered picture is refetched rather than
  // served from the browser's cache, which would show the previous counts.
  const [version, setVersion] = useState(0)

  const load = useCallback(() => {
    fetch(`/api/whatsapp/posts/${postId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: PostPayload & { error?: string }) => {
        if (payload.error) setError(payload.error)
        else setData(payload)
      })
      .catch(() => setError("Failed to load"))
  }, [postId])

  useEffect(load, [load])

  useEffect(() => {
    fetch("/api/whatsapp/shop", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { posts?: ShopPost[] }) => setSiblings(neighbours(data.posts ?? [], postId)))
      .catch(() => setSiblings(null))
  }, [postId])

  async function save(slotId: number, bought: number) {
    const res = await fetch(`/api/whatsapp/slots/${slotId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bought }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to save" }))
      setError(body.error ?? "Failed to save")
      return
    }
    setOpenSlot(null)
    setVersion((v) => v + 1)
    load()
  }

  /**
   * Take her up on a size she offered herself.
   *
   * She wrote "kalau 95 nggak ada, 100 juga boleh" when she ordered, so the
   * consent already exists in writing and nothing needs to be sent or waited
   * for. The bot never acts on that sentence by itself — it only shows it — so
   * this is the owner reading her words and agreeing on the spot.
   */
  async function swap(claimId: number, size: string) {
    const res = await fetch(`/api/whatsapp/claims/${claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to save" }))
      setError(body.error ?? "Failed to save")
      return
    }
    // Her claim has moved to another slot, so this one's counts changed and the
    // sheet is looking at a slot that may no longer hold her.
    setOpenSlot(null)
    setVersion((v) => v + 1)
    load()
  }

  /**
   * Which method prices this shelf.
   *
   * Here as well as on the naming screen because naming happens here now, and
   * the method decides what every SKU on the shelf will cost — a decision that
   * has to be settled before the first Add product, not on another page.
   */
  async function setPricingMethod(pricingMethod: string) {
    await fetch(`/api/whatsapp/posts/${postId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pricingMethod }),
    })
    load()
  }

  async function rename(slotId: number, label: string) {
    await fetch(`/api/whatsapp/slots/${slotId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    })
    setVersion((v) => v + 1)
    load()
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>

  const claimed = data.slots.reduce((n, s) => n + s.claimed, 0)
  const bought = data.slots.reduce((n, s) => n + s.bought, 0)
  const slot = data.slots.find((s) => s.id === openSlot) ?? null
  const zoomed = data.slots.find((s) => s.id === zoomSlot) ?? null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/shop" className="text-sm text-gray-500 hover:text-foreground">
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

        {/* Default follows Settings → WhatsApp, so changing that setting moves
            every shelf not yet named. Picking one here opts this shelf out, and
            naming pins whatever was in force — from then on it is a price
            customers have been quoted. Owners only: it decides what everything
            on the shelf costs. */}
        {canName ? (
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
        ) : null}
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element -- a rendered JPEG
          from our own route; next/image would proxy it for no benefit. */}
      <img
        src={`/api/whatsapp/posts/${postId}/rekap?v=${version}`}
        alt="The shelf with a badge on each SKU showing how many are still to buy"
        className="w-full rounded-xl border border-cream-border"
      />

      <div className="flex flex-col rounded-xl border border-cream-border bg-white overflow-hidden">
        {data.slots.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 px-4 py-3 border-b border-cream-border last:border-b-0"
          >
            {/* A database id says nothing about which pyjamas these are. The
                crop does, and it is the only label an unnamed SKU has. */}
            {s.point ? (
              <button
                type="button"
                onClick={() => setZoomSlot(s.id)}
                aria-label="Look closer at this item"
                className="shrink-0"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- our own crop route. */}
                <img
                  src={`/api/whatsapp/slots/${s.id}/thumb`}
                  alt=""
                  className="w-10 h-10 rounded object-cover border border-cream-border hover:border-brand transition-colors"
                />
              </button>
            ) : null}
            {/* The product name once there is one, then the working name typed
                in the shop, and only then the id. A named SKU showing "SKU 1171"
                looks unnamed, and sends you back to the naming screen to check. */}
            <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
              {s.productName || s.label || `SKU ${s.id}`}
              {s.size ? <span className="text-gray-500 font-normal"> · {s.size}</span> : null}
            </span>
            <span className="text-xs text-gray-400 tabular-nums shrink-0">
              {s.bought}/{s.claimed}
            </span>
            {/* Only the basket opens the tally. The row is where you read what
                the SKU is — crop, name, size, counts — and reading should not
                risk a sheet covering the thing being read. */}
            <button
              type="button"
              onClick={() => setOpenSlot(s.id)}
              aria-label={
                s.claimed - s.bought === 0
                  ? "Done — open the tally"
                  : `${s.claimed - s.bought} still to buy — open the tally`
              }
              className={`flex items-center gap-1 shrink-0 rounded-lg border border-cream-border px-2.5 py-1.5 text-xs font-bold tabular-nums hover:border-brand transition-colors ${tone(s.claimed, s.bought)}`}
            >
              {s.claimed - s.bought === 0 ? (
                <svg
                  width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                <>
                  <svg
                    width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <path d="m5 11 4-7" />
                    <path d="m19 11-4-7" />
                    <path d="M2 11h20l-1.8 8.1a2 2 0 0 1-2 1.9H5.8a2 2 0 0 1-2-1.9z" />
                    <path d="M9 15v3" />
                    <path d="M15 15v3" />
                  </svg>
                  {s.claimed - s.bought}
                </>
              )}
            </button>
          </div>
        ))}
      </div>

      {/* The racks either side, in the order the shop was photographed. Below
          the list rather than above it: you arrive here having counted this
          shelf, which is exactly when the next one is wanted. */}
      {siblings && siblings.total > 1 ? (
        <div className="flex items-center gap-2">
          <NeighbourLink post={siblings.previous} direction="previous" />
          <span className="text-xs text-gray-500 tabular-nums shrink-0">
            {siblings.position} of {siblings.total}
          </span>
          <NeighbourLink post={siblings.next} direction="next" />
        </div>
      ) : null}

      {/* The same sheet the naming screen uses. A shelf is counted and named
          from the same crop — the tag being read for the count is the tag whose
          price is typed — so the drawer travels with the picture rather than
          living on a screen of its own. */}
      {zoomed ? (
        <SlotZoom
          slotId={zoomed.id}
          onClose={() => setZoomSlot(null)}
          caption={[
            zoomed.productName || zoomed.label || `SKU ${zoomed.id}`,
            zoomed.size || null,
            zoomed.productPrice !== null ? `Rp ${fmt(zoomed.productPrice)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          startOpen={canName && zoomed.productId === null}
          form={
            canName ? (
              <SlotNameForm
                slotId={zoomed.id}
                defaultName={zoomed.productName ?? zoomed.label}
                defaultValas={zoomed.productValas}
                defaultGram={zoomed.productGram}
                named={zoomed.productId !== null}
                missing={
                  data.claims.filter(
                    (c) => c.slotId === zoomed.id && (data.unordered ?? []).includes(c.id),
                  ).length
                }
                currency={data.post.currency}
                needsPrice={data.post.effectivePricingMethod === "target_price"}
                blocked={data.claims.some(
                  (c) => c.slotId === zoomed.id && c.state !== "rejected" && c.customer === null,
                )}
                onNamed={() => {
                  setZoomSlot(null)
                  setVersion((v) => v + 1)
                  load()
                }}
                compact
              />
            ) : undefined
          }
        />
      ) : null}

      {slot ? (
        <SlotSheet
          key={slot.id}
          slot={slot}
          claims={data.claims.filter((c) => c.slotId === slot.id && c.state !== "rejected")}
          onClose={() => setOpenSlot(null)}
          onSave={(n) => save(slot.id, n)}
          onRename={(label) => rename(slot.id, label)}
          onSwap={swap}
          onLinked={() => {
            setVersion((v) => v + 1)
            load()
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * One step along the aisle, or a dead end held open.
 *
 * The disabled end keeps its space rather than collapsing, so the button under
 * a thumb does not move between shelves — the first and last rack would
 * otherwise shuffle the row and cost a mis-tap.
 */
function NeighbourLink({
  post, direction,
}: {
  post: ShopPost | null
  direction: "previous" | "next"
}) {
  const label = direction === "next" ? "Next shelf →" : "← Previous shelf"
  const shared =
    "flex-1 rounded-xl border border-cream-border px-4 py-2.5 text-sm font-semibold text-center"

  if (post === null) {
    return <span className={`${shared} text-gray-300 bg-cream/50`}>{label}</span>
  }
  return (
    <Link href={`/dashboard/shop/${post.id}`} className={`${shared} bg-white hover:border-brand`}>
      {label}
    </Link>
  )
}

function SlotSheet({
  slot, claims, onClose, onSave, onRename, onSwap, onLinked,
}: {
  slot: Slot
  claims: Claim[]
  onClose: () => void
  onSave: (bought: number) => void
  onRename: (label: string) => void
  onSwap: (claimId: number, size: string) => void
  onLinked: () => void
}) {
  const [count, setCount] = useState(slot.bought)
  const [label, setLabel] = useState(slot.label)

  const short = slot.claimed - count

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-2xl bg-white p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto h-1 w-9 rounded-full bg-gray-300" />

        <div className="flex items-start gap-3">
          {/* Which item this is, at the moment of counting it. Naming happens at
              the hotel, so in the shop the picture is the only identifier a slot
              has. */}
          {slot.point ? (
            // eslint-disable-next-line @next/next/no-img-element -- our own crop route.
            <img
              src={`/api/whatsapp/slots/${slot.id}/thumb`}
              alt="Close-up of this item on the shelf"
              className="w-16 h-16 rounded-lg object-cover shrink-0 border border-cream-border"
            />
          ) : null}
          <div className="min-w-0 flex-1 flex flex-col gap-1.5">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={slot.productName !== null}
              onBlur={() => label !== slot.label && onRename(label)}
              placeholder={slot.productName ?? "Name it — e.g. brown bear set"}
              className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
            />
            <p className="text-xs text-gray-500 tabular-nums">
              {slot.size ? `Size ${slot.size} · ` : ""}
              {slot.claimed} claimed by {claims.length} {claims.length === 1 ? "person" : "people"}
            </p>
          </div>
        </div>

        {/* A stepper, not a keyboard. Claims are small numbers, and a number pad
            in a shop is where a stray 44 comes from. */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setCount((n) => Math.max(0, n - 1))}
            className="w-12 h-12 rounded-xl border border-cream-border bg-cream text-xl font-semibold"
            aria-label="One fewer"
          >
            −
          </button>
          <div className="flex-1 text-center">
            <div className="text-3xl font-bold tabular-nums leading-none">{count}</div>
            <div className="text-[10px] text-gray-500 tracking-wide">
              GOT / {slot.claimed} CLAIMED
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCount((n) => Math.min(slot.claimed, n + 1))}
            className="w-12 h-12 rounded-xl border border-cream-border bg-cream text-xl font-semibold"
            aria-label="One more"
          >
            +
          </button>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setCount(0)}
            className="flex-1 rounded-full border border-cream-border py-1.5 text-xs font-semibold text-brand bg-brand/5"
          >
            None
          </button>
          <button
            type="button"
            onClick={() => setCount(slot.claimed)}
            className="flex-1 rounded-full border border-cream-border py-1.5 text-xs font-semibold text-brand bg-brand/5"
          >
            All {slot.claimed}
          </button>
        </div>

        <UnknownPanel claims={claims} onLinked={onLinked} />

        <FallbackPanel claims={claims} onSwap={onSwap} />

        {short > 0 && claims.length > 0 ? <ShortPanel claims={claims} count={count} /> : null}

        <button
          type="button"
          onClick={() => onSave(count)}
          className="rounded-xl bg-brand py-2.5 text-sm font-bold text-white"
        >
          Save
        </button>
      </div>
    </div>
  )
}

/**
 * Claimants nobody has a name for, and the box that gives them one.
 *
 * Here rather than in a queue at the top of the page: the number alone says
 * nothing, and what identifies somebody is usually what they claimed — this
 * item, this size, this many. Naming the slot refuses while one of these is
 * outstanding, so the fix belongs beside the thing it blocks.
 *
 * Linking writes the number onto that customer, so the same person is never
 * asked twice, and their waiting claims are picked up with it.
 */
function UnknownPanel({
  claims, onLinked,
}: {
  claims: Claim[]
  onLinked: () => void
}) {
  const [handles, setHandles] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const unknown = claims.filter((c) => c.customer === null)
  if (unknown.length === 0) return null

  async function link(claimId: number) {
    const handle = (handles[claimId] ?? "").trim()
    if (!handle) return
    setBusy(true)
    setError("")
    const res = await fetch(`/api/whatsapp/claims/${claimId}`, {
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
    onLinked()
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-2">
      <p className="text-xs font-semibold text-amber-900">
        {unknown.length} {unknown.length === 1 ? "claim has" : "claims have"} no customer yet
      </p>
      {error ? <p className="text-[11px] text-red-600">{error}</p> : null}
      {unknown.map((claim) => (
        <div key={claim.id} className="flex flex-col gap-1">
          <div className="text-[11px] text-gray-600 tabular-nums">
            {senderDigits(claim.sender)} · {claimedAt(claim.createdAt)} · {claim.quantity}×
            {claim.note ? <span className="text-gray-500"> · “{claim.note}”</span> : null}
          </div>
          <div className="flex gap-1.5">
            <input
              value={handles[claim.id] ?? ""}
              onChange={(e) => setHandles((all) => ({ ...all, [claim.id]: e.target.value }))}
              placeholder="instagram handle"
              className="flex-1 min-w-0 rounded-lg border border-cream-border bg-white px-2 py-1.5 text-xs"
            />
            <button
              type="button"
              disabled={busy || !(handles[claim.id] ?? "").trim()}
              onClick={() => link(claim.id)}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40"
            >
              Link
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Sizes the customer offered herself, ready to take up.
 *
 * "Size 95, kalau nggak ada 100 juga boleh" is common and, until now, dead
 * text: the claim filed under 95 and the sentence went unread by anything. The
 * bot still will not act on it — a sentence can as easily say "definitely not
 * 100" — so her exact words sit beside the button and the owner, who can read
 * them, decides.
 *
 * Shown only while a swap is still possible: nothing to offer, or the shelf is
 * already counted short for another reason, and the panel stays out of the way.
 */
function FallbackPanel({
  claims, onSwap,
}: {
  claims: Claim[]
  onSwap: (claimId: number, size: string) => void
}) {
  const offers = claims
    .filter((claim) => claim.size === null)
    .map((claim) => ({ claim, sizes: alternativeSizes(claim.note) }))
    .filter(({ sizes }) => sizes.length > 0)

  if (offers.length === 0) return null

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-2">
      {offers.map(({ claim, sizes }) => (
        <div key={claim.id} className="flex flex-col gap-1.5">
          <div className="text-xs">
            <span className="font-semibold">{claim.customer ?? senderDigits(claim.sender)}</span>
            <span className="text-gray-600"> also wrote </span>
            <span className="font-semibold tabular-nums">{sizes.join(", ")}</span>
          </div>
          <div className="text-[11px] text-gray-600 leading-snug">“{claim.note}”</div>
          <div className="flex gap-1.5">
            {sizes.map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => onSwap(claim.id, size)}
                className="rounded-full border border-amber-300 bg-white px-3 py-1 text-xs font-bold text-amber-700"
              >
                Switch to {size}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Who walks away with nothing.
 *
 * The order is not arbitrary and is not recomputed here: the server spends the
 * count across claims by paid priority, so this previews the same ordering the
 * save will apply — earliest claims first, which is the tie-break when nobody
 * has paid yet.
 */
function ShortPanel({ claims, count }: { claims: Claim[]; count: number }) {
  let remaining = count
  const rows = claims.map((claim) => {
    const gets = Math.min(claim.quantity, Math.max(0, remaining))
    remaining -= gets
    return { claim, gets }
  })

  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-cream p-2">
      {rows.map(({ claim, gets }) => (
        <div key={claim.id} className="flex items-center gap-2 text-xs">
          <span className="shrink-0">{gets >= claim.quantity ? "✅" : "❔"}</span>
          <span className="flex-1 min-w-0">
            <span className="font-semibold truncate block">
              {claim.customer ?? senderDigits(claim.sender)}
            </span>
            <span className="text-gray-500 block tabular-nums">
              {senderDigits(claim.sender)} · {claimedAt(claim.createdAt)}
            </span>
            {claim.note ? (
              <span className="text-gray-500 block truncate">“{claim.note}”</span>
            ) : null}
          </span>
          <span className="text-gray-500 tabular-nums shrink-0">
            {gets} of {claim.quantity}
          </span>
        </div>
      ))}
    </div>
  )
}
