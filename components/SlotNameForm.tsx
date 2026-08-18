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
 *
 * Creates the product alone. The orders are a separate act on the card, so the
 * price can be read back and checked before anybody is charged it.
 */
export default function SlotNameForm({
  slotId, defaultName, defaultValas, defaultGram, named, missing,
  needsPrice, blocked, onNamed, compact = false,
}: {
  slotId: number
  defaultName: string
  /** What was typed when it was named, for a slot that already has a product. */
  defaultValas?: number | null
  defaultGram?: number | null
  /** Already a product: the fields become a record rather than a form. */
  named?: boolean
  /** Claims on this slot with no order yet. */
  missing?: number
  /** Target Price is the one method whose price a human decides. */
  needsPrice: boolean
  /** A claim here has no customer yet, so naming would drop somebody's order. */
  blocked: boolean
  onNamed: () => void
  /** Tighter spacing, for the sheet that sits over a crop. */
  compact?: boolean
}) {
  const [name, setName] = useState(defaultName)
  const [valas, setValas] = useState(defaultValas ? String(defaultValas) : "")
  const [gram, setGram] = useState(defaultGram ? String(defaultGram) : "")
  const [price, setPrice] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const field = `border border-cream-border rounded-lg px-2 disabled:bg-cream disabled:text-gray-500 ${
    compact ? "py-2 text-[13px]" : "py-1.5 text-sm"
  }`

  /** Give the claims here their lines, at the price this slot already has. */
  async function addOrders() {
    setBusy(true)
    setError("")
    const res = await fetch(`/api/whatsapp/slots/${slotId}/orders`, { method: "POST" })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to add orders" }))
      setError(body.error ?? "Failed to add orders")
      return
    }
    onNamed()
  }

  async function create(withOrders: boolean) {
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
        withOrders,
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
          disabled={named}
          placeholder="Product name"
          className={`col-span-2 ${field}`}
        />
        <input
          value={valas}
          onChange={(e) => setValas(e.target.value)}
          disabled={named}
          inputMode="decimal"
          placeholder="Valas (price tag)"
          className={field}
        />
        <input
          value={gram}
          onChange={(e) => setGram(e.target.value)}
          disabled={named}
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
          One of these senders is not a customer yet. The product can be created;
          their order cannot, until they are linked.
        </p>
      ) : null}

      {/* Naming only. Creating the product settles what the thing is and what
          it costs; putting it on somebody's invoice is the next decision, and
          the button below makes it — so a mistyped valas is caught before anyone
          is charged for it. */}
      <button
        type="button"
        disabled={busy || named || !name.trim()}
        onClick={() => create(false)}
        className={`rounded-lg bg-brand font-bold text-white disabled:opacity-40 ${
          compact ? "py-2.5 text-sm" : "py-1.5 text-xs"
        }`}
      >
        {named ? "Produk sudah dibuat" : busy ? "Membuat…" : "Buat produk"}
      </button>

      {/* Live only while somebody on this slot has no order. A named slot keeps
          taking claims — the rack is still in the group — and this is how they
          reach an invoice. */}
      {named && (missing ?? 0) > 0 ? (
        <button
          type="button"
          disabled={busy}
          onClick={addOrders}
          className={`rounded-lg border border-amber-300 bg-white font-bold text-amber-800 disabled:opacity-40 ${
            compact ? "py-2.5 text-sm" : "py-1.5 text-xs"
          }`}
        >
          {busy ? "Membuat…" : `Buat ${missing} order lagi`}
        </button>
      ) : null}
    </div>
  )
}
