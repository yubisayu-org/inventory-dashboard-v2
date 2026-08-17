"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { senderDigits, claimedAt } from "@/lib/format"

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
  createdAt: string
}

interface PostPayload {
  post: { id: number; event: string; store: string }
  slots: Slot[]
  claims: Claim[]
}

const tone = (claimed: number, bought: number) =>
  bought >= claimed ? "text-green-700" : bought > 0 ? "text-amber-600" : "text-red-700"

const dot = (claimed: number, bought: number) =>
  bought >= claimed ? "bg-green-600" : bought > 0 ? "bg-amber-500" : "bg-red-600"

export default function ShopPostClient({ postId }: { postId: number }) {
  const [data, setData] = useState<PostPayload | null>(null)
  const [error, setError] = useState("")
  const [openSlot, setOpenSlot] = useState<number | null>(null)
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/shop" className="text-sm text-gray-500 hover:text-foreground">
          ←
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-foreground truncate">
            {data.post.store || "Untitled shelf"}
          </h1>
          <p className="text-xs text-gray-500 tabular-nums">
            {data.post.event} · {data.slots.length} SKU · {bought} of {claimed} units
          </p>
        </div>
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
          <button
            key={s.id}
            type="button"
            onClick={() => setOpenSlot(s.id)}
            className="flex items-center gap-3 px-4 py-3 border-b border-cream-border last:border-b-0 text-left hover:bg-cream transition-colors"
          >
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot(s.claimed, s.bought)}`} />
            {/* A database id says nothing about which pyjamas these are. The
                crop does, and it is the only label an unnamed SKU has. */}
            {s.point ? (
              // eslint-disable-next-line @next/next/no-img-element -- our own crop route.
              <img
                src={`/api/whatsapp/slots/${s.id}/thumb`}
                alt=""
                className="w-10 h-10 rounded object-cover shrink-0 border border-cream-border"
              />
            ) : null}
            <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
              {s.label || `SKU ${s.id}`}
              {s.size ? <span className="text-gray-500 font-normal"> · {s.size}</span> : null}
            </span>
            <span className="text-xs text-gray-400 tabular-nums shrink-0">
              {s.bought}/{s.claimed}
            </span>
            <span className={`text-xs font-bold tabular-nums shrink-0 ${tone(s.claimed, s.bought)}`}>
              {s.claimed - s.bought === 0 ? "DONE" : `BUY ${s.claimed - s.bought}`}
            </span>
          </button>
        ))}
      </div>

      {slot ? (
        <SlotSheet
          key={slot.id}
          slot={slot}
          claims={data.claims.filter((c) => c.slotId === slot.id && c.state !== "rejected")}
          onClose={() => setOpenSlot(null)}
          onSave={(n) => save(slot.id, n)}
          onRename={(label) => rename(slot.id, label)}
        />
      ) : null}
    </div>
  )
}

function SlotSheet({
  slot, claims, onClose, onSave, onRename,
}: {
  slot: Slot
  claims: Claim[]
  onClose: () => void
  onSave: (bought: number) => void
  onRename: (label: string) => void
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
              onBlur={() => label !== slot.label && onRename(label)}
              placeholder="Name it — e.g. brown bear set"
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
