"use client"

import { useState } from "react"

/**
 * The three fields that turn a marked spot into a product.
 *
 * Extracted so the naming card and the zoom viewer share one, rather than the
 * viewer growing a second copy that drifts: the valas a customer is charged
 * cannot depend on which screen it was typed into.
 *
 * Name, valas and gram — nothing else. Store, country, event and pricing method
 * come from the post, because the owner set them once when posting and
 * re-typing them per item would be fifteen chances to disagree.
 */
export default function SlotNameForm({
  slotId, defaultName, needsPrice, blocked, onNamed, compact = false,
}: {
  slotId: number
  defaultName: string
  /** Target Price is the one method whose price a human decides. */
  needsPrice: boolean
  /** A claim here has no customer yet, so naming would drop somebody's order. */
  blocked: boolean
  onNamed: () => void
  /** Tighter spacing, for the sheet that sits over a crop. */
  compact?: boolean
}) {
  const [name, setName] = useState(defaultName)
  const [valas, setValas] = useState("")
  const [gram, setGram] = useState("")
  const [price, setPrice] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const field = `border border-cream-border rounded-lg px-2 ${
    compact ? "py-2 text-[13px]" : "py-1.5 text-sm"
  }`

  async function create() {
    setBusy(true)
    setError("")
    const res = await fetch(`/api/whatsapp/slots/${slotId}/name`, {
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
    onNamed()
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Product name"
          className={`col-span-2 ${field}`}
        />
        <input
          value={valas}
          onChange={(e) => setValas(e.target.value)}
          inputMode="decimal"
          placeholder="Valas (price tag)"
          className={field}
        />
        <input
          value={gram}
          onChange={(e) => setGram(e.target.value)}
          inputMode="numeric"
          placeholder="Gram"
          className={field}
        />
        {/* Only where the method has no formula to derive a price from. Every
            other method computes one from the valas, the kurs and the weight, so
            the box was a permanent invitation to type a number that would be
            ignored. */}
        {needsPrice ? (
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="numeric"
            placeholder="Harga jual (Target Price)"
            className={`col-span-2 ${field}`}
          />
        ) : null}
      </div>

      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      {blocked ? (
        <p className="text-xs text-amber-700">
          One of these senders is not a customer yet. Link them first — naming now
          would drop their order.
        </p>
      ) : null}

      <button
        type="button"
        disabled={busy || blocked || !name.trim()}
        onClick={create}
        className={`rounded-lg bg-brand font-bold text-white disabled:opacity-40 ${
          compact ? "py-2.5 text-sm" : "py-1.5 text-xs"
        }`}
      >
        Create product and orders
      </button>
    </div>
  )
}
