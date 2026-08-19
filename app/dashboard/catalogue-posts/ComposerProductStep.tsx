"use client"

import { useEffect, useState } from "react"
import ProductSearchPicker from "@/components/ProductSearchPicker"

interface WaSendCode {
  id: number
  sendId: number
  productId: number
  productName: string
  code: string
  event: string
  price: number
  pointX: number | null
  pointY: number | null
  position: number
}

/**
 * The composer's product step: tag products onto the send (search or
 * pre-fill from a past post), place a pin for each on the photo, watch the
 * exact outgoing caption update live, then send.
 *
 * `sendId`/`mediaUrl` are always real (a `wa_sends` row already exists by
 * the time this renders — Task 8's upload step created it).
 * `prefillFromPostId` is set only for "Pakai post lama": on mount, this
 * fetches that past post's currently-tagged products and re-attaches each
 * to `sendId`, one call at a time — codes are issued in request order
 * (see `attachProductToSend`'s `nextCode`), so the loop must stay
 * sequential, never `Promise.all`.
 *
 * Removing an already-attached product is deliberately NOT built here: no
 * `DELETE /api/whatsapp/sends/[id]/products/[codeId]` route exists anywhere
 * in this plan, and manual testing (see the report) didn't turn up a case
 * where its absence made the composer feel unusable. YAGNI: add it later if
 * real usage proves this too rigid.
 *
 * Discarding the whole draft (`DELETE /api/whatsapp/sends/[id]`, only
 * available before it's sent) is NOT a full undo for a wrong pick, despite
 * how it might look: `attachProductToSend` also inserts into
 * `catalogue_post_products`, tagging the product onto the underlying
 * `catalogue_posts` row directly — the send's own cascade (`wa_send_codes`/
 * `wa_outbox` via `send_id`) never touches that table, so the tag survives
 * a discarded draft permanently. On the "Pakai post lama" path specifically
 * this means a bad tag keeps getting re-attached on every future repost of
 * that post, since prefill reads the post's *current* tags. The mitigation
 * is that a fresh post defaults to `catalogue_posts.visible = false`, so a
 * stray tag isn't publicly exposed by itself — but it is a real, persistent
 * data artifact, not something this step can clean up.
 */
export default function ComposerProductStep({
  sendId,
  mediaUrl,
  prefillFromPostId,
  onDone,
}: {
  sendId: number
  mediaUrl: string
  prefillFromPostId?: number
  onDone: () => void
}) {
  const [codes, setCodes] = useState<WaSendCode[]>([])
  // The live preview's text is fetched from the server's own renderCaption
  // (via the new caption route) — never re-implemented here — so the
  // preview and the actually-sent caption can never drift apart.
  const [caption, setCaption] = useState("")
  const [placingCodeId, setPlacingCodeId] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [prefilling, setPrefilling] = useState(Boolean(prefillFromPostId))
  const [error, setError] = useState("")

  async function loadCodes() {
    const res = await fetch(`/api/whatsapp/sends/${sendId}`, { cache: "no-store" })
    const data = await res.json()
    if (res.ok) setCodes(data.codes ?? [])
  }

  async function loadCaption() {
    const res = await fetch(`/api/whatsapp/sends/${sendId}/caption`, { cache: "no-store" })
    const data = await res.json()
    if (res.ok) setCaption(data.caption ?? "")
  }

  async function refresh() {
    await Promise.all([loadCodes(), loadCaption()])
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendId])

  // Pre-fill from a reused post's tagged products, attaching one at a time.
  // The `cancelled` guard (checked before every attach) also protects
  // against React 18 dev Strict Mode's mount→cleanup→mount double-invoke:
  // the first invocation's loop always sees `cancelled === true` before it
  // can issue a single attach, so nothing gets double-attached.
  useEffect(() => {
    if (!prefillFromPostId) return
    let cancelled = false
    async function run() {
      try {
        const res = await fetch(`/api/sheets/catalogue-posts/${prefillFromPostId}`, { cache: "no-store" })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to load past post")
        const productIds: number[] = data.post?.productIds ?? []
        for (const productId of productIds) {
          if (cancelled) return
          await attachProduct(productId)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to pre-fill products")
      } finally {
        if (!cancelled) setPrefilling(false)
      }
    }
    run()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillFromPostId])

  async function attachProduct(productId: number) {
    const res = await fetch(`/api/whatsapp/sends/${sendId}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? "Failed to attach product")
    await refresh()
  }

  async function onPick(product: { id: number }) {
    setError("")
    try {
      await attachProduct(product.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to attach product")
    }
  }

  async function placePin(codeId: number, x: number, y: number) {
    setError("")
    try {
      const res = await fetch(`/api/whatsapp/sends/${sendId}/products/${codeId}/pin`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to place pin")
      setPlacingCodeId(null)
      await loadCodes()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to place pin")
    }
  }

  async function handleSend() {
    if (codes.length === 0) {
      setError("Tag at least one product before sending")
      return
    }
    setSending(true)
    setError("")
    try {
      const res = await fetch(`/api/whatsapp/sends/${sendId}/send`, { method: "POST" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to send")
      window.alert("Terkirim ke grup WhatsApp.")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send")
    } finally {
      setSending(false)
    }
  }

  const alreadyAddedIds = new Set(codes.map((c) => c.productId))
  const placingCode = codes.find((c) => c.id === placingCodeId) ?? null

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {prefilling && <p className="text-xs text-gray-400">Menyalin produk dari post sebelumnya…</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="relative self-start">
          {/* eslint-disable-next-line @next/next/no-img-element -- either a
              client-side blob: preview or our own stored media_url; next/image
              would proxy either for no benefit. */}
          <img
            src={mediaUrl}
            alt=""
            onClick={(e) => {
              if (placingCodeId === null) return
              // Same normalized-coordinate click pattern as ShopPostClient's
              // shelf photo: fraction of the rendered image, 0..1, matching
              // whatever coordinate space a customer's own drawn mark uses.
              const box = e.currentTarget.getBoundingClientRect()
              const x = (e.clientX - box.left) / box.width
              const y = (e.clientY - box.top) / box.height
              placePin(placingCodeId, x, y)
            }}
            className={`w-full rounded-xl border border-cream-border ${
              placingCodeId !== null ? "cursor-crosshair ring-2 ring-brand" : ""
            }`}
          />
          {codes
            .filter((c) => c.pointX !== null && c.pointY !== null)
            .map((c) => (
              <span
                key={c.id}
                style={{ left: `${(c.pointX as number) * 100}%`, top: `${(c.pointY as number) * 100}%` }}
                className="absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center min-w-6 h-6 px-1 rounded-full bg-brand text-white text-[10px] font-bold border-2 border-white shadow"
              >
                {c.code}
              </span>
            ))}
          {placingCode && (
            <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white backdrop-blur-sm">
              Tap foto untuk taruh pin kode {placingCode.code}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-cream-border bg-white p-3 flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-foreground">Cari & tambah produk</h3>
            <ProductSearchPicker alreadyAddedIds={alreadyAddedIds} onPick={onPick} />
          </div>

          <div className="rounded-xl border border-cream-border bg-white p-3 flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold text-foreground">Produk yang sudah ditandai</h3>
            {codes.length === 0 ? (
              <p className="text-xs text-gray-400">Belum ada produk.</p>
            ) : (
              codes.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-2 text-xs py-1.5 border-b border-cream-border last:border-b-0"
                >
                  <span className="font-bold tabular-nums w-10 shrink-0">{c.code}</span>
                  <span className="flex-1 min-w-0 truncate">{c.productName}</span>
                  <span className="text-gray-500 tabular-nums shrink-0">Rp {c.price.toLocaleString("id-ID")}</span>
                  <button
                    type="button"
                    onClick={() => setPlacingCodeId(placingCodeId === c.id ? null : c.id)}
                    className={`shrink-0 px-2 py-1 rounded-lg text-[11px] border ${
                      placingCodeId === c.id ? "bg-brand text-white border-brand" : "border-cream-border"
                    }`}
                  >
                    {placingCodeId === c.id ? "Batal" : c.pointX !== null ? "Ubah pin" : "Taruh pin"}
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="rounded-xl border border-cream-border bg-[#e5ddd5] p-3 flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold text-foreground">Yang dikirim ke grup</h3>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs bg-white rounded-lg p-3 border border-cream-border">
              {caption || "…"}
            </pre>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="px-4 py-2 rounded-lg border border-cream-border text-sm"
        >
          Simpan draf
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={sending || codes.length === 0}
          className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-semibold disabled:opacity-50"
        >
          {sending ? "Mengirim…" : "Kirim ke grup"}
        </button>
      </div>
    </div>
  )
}
