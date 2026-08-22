"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { fmt, senderDigits, claimedAt } from "@/lib/format"
import { PRICING_METHODS, PRICING_METHOD_LABEL, type PricingMethod } from "@/lib/pricing"
import { alternativeSizes } from "@/lib/claims/size"
import { neighbours, type Neighbours, type ShopPost } from "../stores"
import PageHeader from "@/components/PageHeader"
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
  /** Set when this claim's WhatsApp reply photo was kept. */
  replyImagePath: string | null
  /** The matched customer's WhatsApp number, when known — the fallback for
   *  a DM-recorded claim, which has no WhatsApp JID of its own to show
   *  digits from. */
  customerWhatsapp: string | null
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
    /** Empty until the bot actually posts this shelf to the group. */
    messageId: string
  }
  slots: Slot[]
  claims: Claim[]
  /** Claims on a named slot with no order yet. */
  unordered: number[]
}

const tone = (claimed: number, bought: number) =>
  bought >= claimed ? "text-green-700" : bought > 0 ? "text-amber-600" : "text-red-700"

/** Digits to show beside a claimant's handle. Normally the WhatsApp JID's own
 *  digits — but a DM-recorded claim has no JID (`sender` is empty), so it
 *  falls back to the matched customer's number on file. */
const contactDigits = (claim: Claim) =>
  claim.sender ? senderDigits(claim.sender) : (claim.customerWhatsapp ?? "")

export default function ShopPostClient({
  postId, canName, canTally,
}: {
  postId: number
  /** Naming a SKU, and the pricing method behind it. */
  canName: boolean
  /**
   * Whether the counter in the tally may be moved.
   *
   * Owners only. The controls are hidden rather than disabled for an admin:
   * a stepper that refuses every press reads as a broken screen, and the rest
   * of the sheet — who claimed, who is unidentified, who is short — is still
   * worth opening.
   */
  canTally: boolean
}) {
  const [data, setData] = useState<PostPayload | null>(null)
  const [error, setError] = useState("")
  const [openSlot, setOpenSlot] = useState<number | null>(null)
  // The crop, big. Separate from the tally: "which pyjamas are these" and "how
  // many did I find" are different questions, and in a shop the first is asked
  // far more often.
  const [zoomSlot, setZoomSlot] = useState<number | null>(null)
  /**
   * Recording an order that arrived privately.
   *
   * A mode rather than a permanent behaviour: the shelf photograph is something
   * you touch to scroll and pinch, and a tap that always created a claim would
   * put an order on somebody's invoice by accident. Null when off; a slot id or
   * a point on the photo once there is something to record.
   */
  const [adding, setAdding] = useState<
    | null
    | { kind: "picking" }
    | { kind: "slot"; slotId: number }
    | { kind: "point"; x: number; y: number }
  >(null)
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

  const [announcing, setAnnouncing] = useState(false)
  async function announce() {
    setAnnouncing(true)
    setError("")
    const res = await fetch(`/api/whatsapp/posts/${postId}`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to post" }))
      setError(body.error ?? "Failed to post")
    }
    setAnnouncing(false)
    load()
  }

  async function addClaim(input: {
    slotId?: number
    point?: { x: number; y: number }
    customer: string
    quantity: number
    note: string
  }) {
    const res = await fetch(`/api/whatsapp/posts/${postId}/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to save" }))
      return (body.error as string) ?? "Failed to save"
    }
    setAdding(null)
    setOpenSlot(null)
    setVersion((v) => v + 1)
    load()
    return ""
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
  if (!data) return <p className="text-sm text-muted">Loading…</p>

  const claimed = data.slots.reduce((n, s) => n + s.claimed, 0)
  const bought = data.slots.reduce((n, s) => n + s.bought, 0)
  const slot = data.slots.find((s) => s.id === openSlot) ?? null
  const zoomed = data.slots.find((s) => s.id === zoomSlot) ?? null

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        compact
        title={data.post.store || "Untitled shelf"}
        subtitle={
          <span className="tabular-nums">
            {data.post.event} · {data.slots.length} SKU · {bought} of {claimed} units
          </span>
        }
        before={
          <Link href="/dashboard/shop" className="text-sm text-muted hover:text-foreground">
            ←
          </Link>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* Default follows Settings → WhatsApp, so changing that setting moves
            every shelf not yet named. Picking one here opts this shelf out, and
            naming pins whatever was in force — from then on it is a price
            customers have been quoted. */}
        {canName ? (
          <label className="flex items-center gap-2 text-xs text-muted shrink-0">
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

        {/* Empty until the bot actually posts it — uploaded with "Post to the
            WhatsApp group" unchecked, or the trip had no group bound yet at
            upload time. Owners only, same reasoning as the pricing picker
            above: this puts a message in the group. */}
        {canName && !data.post.messageId ? (
          <button
            type="button"
            onClick={announce}
            disabled={announcing}
            title="Post to WhatsApp group"
            aria-label="Post to WhatsApp group"
            className="shrink-0 inline-flex items-center justify-center border border-cream-border rounded-lg px-2 py-1.5 bg-white text-muted hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m22 2-7 20-4-9-9-4Z" />
              <path d="M22 2 11 13" />
            </svg>
            </button>
            ) : null}
          </div>
        }
      />

      <div className="relative">
      {/* eslint-disable-next-line @next/next/no-img-element -- a rendered JPEG
          from our own route; next/image would proxy it for no benefit. */}
      <img
        src={`/api/whatsapp/posts/${postId}/rekap?v=${version}`}
        alt="The shelf with a badge on each SKU showing how many are still to buy"
        onClick={(e) => {
          if (adding?.kind !== "picking") return
          // Where on the photograph, in the same 0..1 coordinates a customer's
          // mark produces — so a typed order clusters exactly like a drawn one.
          const box = e.currentTarget.getBoundingClientRect()
          setAdding({
            kind: "point",
            x: (e.clientX - box.left) / box.width,
            y: (e.clientY - box.top) / box.height,
          })
        }}
        className={`w-full rounded-xl border border-cream-border ${
          adding?.kind === "picking" ? "cursor-crosshair ring-2 ring-brand" : ""
        }`}
      />

      {/* On the photograph, because the photograph is what it acts on: press it
          and the shelf takes a tap where she pointed. A mode, so an ordinary
          touch cannot put an order on somebody's invoice. */}
      <button
        type="button"
        onClick={() => setAdding(adding ? null : { kind: "picking" })}
        aria-label={adding ? "Cancel recording an order" : "Record an order from a DM"}
        title={adding ? "Cancel" : "Record an order that came by DM"}
        className={`absolute bottom-2 right-2 w-10 h-10 rounded-full flex items-center justify-center backdrop-blur-sm ${
          adding ? "bg-brand text-white" : "bg-black/55 text-white"
        }`}
      >
        {adding ? (
          <svg
            width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round"
          >
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        ) : (
          <svg
            width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="m5 11 4-7" />
            <path d="m19 11-4-7" />
            <path d="M2 11h20l-1.8 8.1a2 2 0 0 1-2 1.9H5.8a2 2 0 0 1-2-1.9z" />
            <path d="M12 14v4" />
            <path d="M10 16h4" />
          </svg>
        )}
      </button>

      {adding?.kind === "picking" ? (
        <span className="absolute bottom-3 left-2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white backdrop-blur-sm">
          Tap where she pointed, or a SKU below
        </span>
      ) : null}
      </div>

      {data.slots.length === 0 ? (
        <p className="text-sm text-muted">
          {data.claims.some((c) => c.state !== "rejected")
            ? `${data.claims.filter((c) => c.state !== "rejected").length} mark(s) recorded, not tallied into SKUs yet — that happens at the naming session.`
            : "No items marked on this shelf yet — tap the basket on the photo to record one."}
        </p>
      ) : (
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
                  className="w-10 h-10 rounded object-cover border border-cream-border hover:border-brand hover:text-brand transition-colors"
                />
              </button>
            ) : null}
            {/* The product name once there is one, then the working name typed
                in the shop, and only then the id. A named SKU showing "SKU 1171"
                looks unnamed, and sends you back to the naming screen to check. */}
            <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
              {s.productName || s.label || `SKU ${s.id}`}
              {s.size ? <span className="text-muted font-normal"> · {s.size}</span> : null}
            </span>
            <span className="text-xs text-faint tabular-nums shrink-0">
              {s.bought}/{s.claimed}
            </span>
            {/* Only the basket opens the tally. The row is where you read what
                the SKU is — crop, name, size, counts — and reading should not
                risk a sheet covering the thing being read. */}
            <button
              type="button"
              onClick={() =>
                adding?.kind === "picking"
                  ? setAdding({ kind: "slot", slotId: s.id })
                  : setOpenSlot(s.id)
              }
              aria-label={
                s.claimed - s.bought === 0
                  ? "Done — open the tally"
                  : `${s.claimed - s.bought} still to buy — open the tally`
              }
              className={`flex items-center gap-1 shrink-0 rounded-lg border border-cream-border px-2.5 py-1.5 text-xs font-bold tabular-nums hover:border-brand hover:text-brand transition-colors ${tone(s.claimed, s.bought)}`}
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
      )}

      {/* The racks either side, in the order the shop was photographed. Below
          the list rather than above it: you arrive here having counted this
          shelf, which is exactly when the next one is wanted. */}
      {siblings && siblings.total > 1 ? (
        <div className="flex items-center gap-2">
          <NeighbourLink post={siblings.previous} direction="previous" />
          <span className="text-xs text-muted tabular-nums shrink-0">
            {siblings.position} of {siblings.total}
          </span>
          <NeighbourLink post={siblings.next} direction="next" />
        </div>
      ) : null}

      {/* The same sheet the naming screen uses. A shelf is counted and named
          from the same crop — the tag being read for the count is the tag whose
          price is typed — so the drawer travels with the picture rather than
          living on a screen of its own. */}
      {adding && adding.kind !== "picking" ? (
        <AddOrderSheet
          target={adding}
          onClose={() => setAdding({ kind: "picking" })}
          onSave={addClaim}
        />
      ) : null}

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
          canTally={canTally}
          onSave={(n) => save(slot.id, n)}
          onRename={(label) => rename(slot.id, label)}
          onSwap={swap}
          onLinked={() => {
            setVersion((v) => v + 1)
            load()
          }}
          onAddOrder={() => setAdding({ kind: "slot", slotId: slot.id })}
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
    return <span className={`${shared} text-faint bg-cream/50`}>{label}</span>
  }
  return (
    <Link href={`/dashboard/shop/${post.id}`} className={`${shared} bg-white hover:border-brand hover:text-brand`}>
      {label}
    </Link>
  )
}

/**
 * An order taken privately, typed in.
 *
 * The customer must already exist: orders, invoices and the public invoice site
 * all key on the handle, so inventing one here would make a customer nobody can
 * find again. The server refuses an unknown handle and says so.
 */
function AddOrderSheet({
  target, onClose, onSave,
}: {
  target: { kind: "slot"; slotId: number } | { kind: "point"; x: number; y: number }
  onClose: () => void
  onSave: (input: {
    slotId?: number
    point?: { x: number; y: number }
    customer: string
    quantity: number
    note: string
  }) => Promise<string>
}) {
  const [customer, setCustomer] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function save() {
    setBusy(true)
    const message = await onSave({
      ...(target.kind === "slot" ? { slotId: target.slotId } : { point: { x: target.x, y: target.y } }),
      customer,
      quantity: Number(quantity) || 1,
      note,
    })
    setBusy(false)
    setError(message)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-xl bg-white p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto h-1 w-9 rounded-full bg-divider" />
        <div>
          <h2 className="text-sm font-bold text-foreground">Pesanan dari DM</h2>
          <p className="text-[11px] text-muted">
            {target.kind === "slot"
              ? "Ditambahkan ke SKU yang dipilih."
              : "Ditandai di titik yang kakak tap — SKU baru dibuat kalau belum ada."}
          </p>
        </div>

        <input
          value={customer}
          onChange={(e) => setCustomer(e.target.value)}
          placeholder="instagram handle"
          className="border border-cream-border rounded-lg px-3 py-2 text-sm"
        />
        <div className="flex gap-2">
          <input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            inputMode="numeric"
            className="w-20 border border-cream-border rounded-lg px-3 py-2 text-sm tabular-nums"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="catatan — size 95, yang kuning"
            className="flex-1 min-w-0 border border-cream-border rounded-lg px-3 py-2 text-sm"
          />
        </div>

        {error ? <p className="text-xs text-red-600">{error}</p> : null}

        <button
          type="button"
          disabled={busy || !customer.trim()}
          onClick={save}
          className="rounded-lg bg-brand py-2 text-sm font-bold text-white disabled:opacity-40"
        >
          {busy ? "Menyimpan…" : "Catat pesanan"}
        </button>
      </div>
    </div>
  )
}

function SlotSheet({
  slot, claims, canTally, onClose, onSave, onRename, onSwap, onLinked, onAddOrder,
}: {
  slot: Slot
  claims: Claim[]
  /** Whether the count may be moved. See ShopPostClient. */
  canTally: boolean
  onClose: () => void
  onSave: (bought: number) => void
  onRename: (label: string) => void
  onSwap: (claimId: number, size: string) => void
  onLinked: () => void
  /** Record an order for this SKU that arrived privately. */
  onAddOrder: () => void
}) {
  const [count, setCount] = useState(slot.bought)
  const [label, setLabel] = useState(slot.label)
  const [viewingClaimId, setViewingClaimId] = useState<number | null>(null)
  const viewingClaim = claims.find((c) => c.id === viewingClaimId) ?? null

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-xl bg-white p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto h-1 w-9 rounded-full bg-divider" />

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
            <p className="text-xs text-muted tabular-nums">
              {slot.size ? `Size ${slot.size} · ` : ""}
              {slot.claimed} claimed by {claims.length} {claims.length === 1 ? "person" : "people"}
            </p>
          </div>
        </div>

        {/* A stepper, not a keyboard. Claims are small numbers, and a number pad
            in a shop is where a stray 44 comes from. */}
        {canTally ? (
          <>
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
                <div className="text-[10px] text-muted tracking-wide">
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
          </>
        ) : (
          /* The same figure, stated rather than offered. An admin needs to know
             how many were got — it is why half this sheet is worth reading — but
             the count is not theirs to move. */
          <div className="rounded-xl border border-cream-border bg-cream py-3 text-center">
            <div className="text-3xl font-bold tabular-nums leading-none">{slot.bought}</div>
            <div className="text-[10px] text-muted tracking-wide">
              GOT / {slot.claimed} CLAIMED
            </div>
          </div>
        )}

        {/* An order taken in a DM, on the SKU already open. The other way in is
            the basket on the photograph, for something nobody has claimed yet —
            this is the common case, where she asked for a thing somebody else
            has already asked for. */}
        <button
          type="button"
          onClick={onAddOrder}
          className="rounded-xl border border-dashed border-cream-border py-2 text-xs font-bold text-brand"
        >
          + Tambah pemesan (dari DM)
        </button>

        <UnknownPanel claims={claims} onLinked={onLinked} />

        <FallbackPanel claims={claims} onSwap={onSwap} />

        {claims.length > 0 ? (
          <ShortPanel claims={claims} count={count} onOpenProof={setViewingClaimId} />
        ) : null}

        {/* Save writes the count and nothing else, so without the tally there is
            nothing here to save. Closing is the whole exit. */}
        {canTally ? (
          <button
            type="button"
            onClick={() => onSave(count)}
            className="rounded-lg bg-brand py-2 text-sm font-bold text-white"
          >
            Save
          </button>
        ) : (
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-cream-border py-2.5 text-sm font-bold text-muted"
          >
            Tutup
          </button>
        )}
      </div>

      {viewingClaim ? (
        <ClaimPhotoViewer claim={viewingClaim} onClose={() => setViewingClaimId(null)} />
      ) : null}
    </div>
  )
}

/**
 * The customer's own marked-up reply photo, full-screen — the same dark
 * shell as SlotZoom, minus its zoom-step controls. There is nothing to crop
 * tighter into: the kept copy is already capped at 2250px on its long side.
 */
function ClaimPhotoViewer({ claim, onClose }: { claim: Claim; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div className="relative w-[min(90vw,640px)]" onClick={(e) => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element -- our own reply-image route. */}
        <img
          src={`/api/whatsapp/claims/${claim.id}/reply-image`}
          alt="Foto balasan dari pelanggan"
          className="w-full rounded-xl bg-black"
        />

        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-2 right-2 w-9 h-9 rounded-full bg-black/60 text-white flex items-center justify-center"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <div className="absolute left-0 right-0 bottom-0 rounded-b-xl bg-gradient-to-t from-black/75 to-transparent px-3.5 py-3 text-white">
          <p className="text-sm font-bold">
            {claim.customer ?? contactDigits(claim)}
            {claim.size || claim.note ? ` · ${claim.size ?? claim.note}` : ""}
          </p>
          <p className="text-xs text-white/70 tabular-nums">
            {contactDigits(claim)} · {claimedAt(claim.createdAt)}
          </p>
        </div>
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
          <div className="text-[11px] text-muted-strong tabular-nums">
            {contactDigits(claim)} · {claimedAt(claim.createdAt)} · {claim.quantity}×
            {claim.note ? <span className="text-muted"> · “{claim.note}”</span> : null}
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
            <span className="font-semibold">{claim.customer ?? contactDigits(claim)}</span>
            <span className="text-muted-strong"> also wrote </span>
            <span className="font-semibold tabular-nums">{sizes.join(", ")}</span>
          </div>
          <div className="text-[11px] text-muted-strong leading-snug">“{claim.note}”</div>
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
 * Who is behind this SKU, and what each of them gets.
 *
 * Shown whether or not anybody misses out: "who wanted this" is the question
 * asked in a shop holding the item, and it was disappearing exactly when the
 * slot was fully bought — which is when the owner is deciding whose it is.
 *
 * The order is not arbitrary and is not recomputed here: the server spends the
 * count across claims by paid priority, so this previews the same ordering the
 * save will apply — earliest claims first, which is the tie-break when nobody
 * has paid yet.
 */
function ShortPanel({ claims, count, onOpenProof }: { claims: Claim[]; count: number; onOpenProof: (claimId: number) => void }) {
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
          {/* Three different facts, three different marks. A tick is bought in
              full; a question mark is a sender nobody has identified, which is
              a question for you rather than a shortage; and a shortage says so
              in the count on the right, which is where the number belongs. */}
          <span className="shrink-0">
            {claim.customer === null ? "❔" : gets >= claim.quantity ? "✅" : "○"}
          </span>
          <span className="flex-1 min-w-0">
            <span className="truncate block tabular-nums">
              <span className="font-semibold">{claim.customer ?? contactDigits(claim)}</span>
              <span className="text-muted"> · {contactDigits(claim)} · {claimedAt(claim.createdAt)}</span>
            </span>
            {claim.note ? (
              <span className="text-muted block truncate">“{claim.note}”</span>
            ) : null}
          </span>
          <span className="text-muted tabular-nums shrink-0">
            {gets} of {claim.quantity}
          </span>
          {claim.replyImagePath !== null ? (
            <button
              type="button"
              onClick={() => onOpenProof(claim.id)}
              aria-label="Lihat foto balasan"
              title="Lihat foto balasan"
              className="w-6 h-6 rounded-lg bg-amber-50 text-amber-700 flex items-center justify-center shrink-0"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}
