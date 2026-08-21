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
 * The composer's product step: give the post a title, tag products onto the
 * send (search or pre-fill from a past post), place a pin for each on the
 * photo, watch the exact outgoing caption update live, then send.
 *
 * `sendId`/`mediaUrl` are always real (a `wa_sends` row already exists by
 * the time this renders). `postId` is the underlying `catalogue_posts` row
 * (migration 086: title lives there, not on the send) — this fetches its
 * current title once on mount and saves back to it on blur, so the same
 * title editor works whether this is a fresh upload or an existing post
 * being retagged from the plain list.
 *
 * `prefillFromPostId` is set only for "Pakai post lama": on mount, this
 * fetches that past post's currently-tagged, still-active products and
 * re-attaches each to `sendId` at its last known pin position, one call at
 * a time — codes are issued in request order (see `attachProductToSend`'s
 * `nextCode`), so the loop must stay sequential, never `Promise.all`. A
 * product tagged before but delisted since is named, struck through, in
 * the tagged-products panel instead of being silently re-attached or
 * silently dropped.
 *
 * The bin button deletes the whole post (`DELETE
 * /api/sheets/catalogue-posts/[id]`, deleteCataloguePost), not just this
 * draft send — it also removes `catalogue_post_products` and the storage
 * file, so no orphaned tag survives it. A send that already went out keeps
 * its `wa_send_codes` (detached from the post, never reissued); an unsent
 * draft's codes are freed for reuse.
 *
 * "Save & close" / "Discard draft" (final whole-branch review's finding 3):
 * the spec calls a saved-not-sent send "resumable later", but nothing in
 * this app can actually find or reopen one afterwards on its own — there is
 * no drafts-list UI anywhere. EditProductsModal's find-or-create draft
 * (`draft-for-post`) is the first real resume path, scoped to one post at a
 * time; a general drafts list is still not built. A code minted on an
 * unsent send can no longer resolve a real customer's claim either way (see
 * `getSendCodeByCode`), so leaving one behind by clicking "Save & close" is
 * wasteful, not unsafe.
 */
export default function ComposerProductStep({
  sendId,
  postId,
  mediaUrl,
  mediaType,
  prefillFromPostId,
  onDone,
}: {
  sendId: number
  postId: number
  mediaUrl: string
  mediaType: "photo" | "video"
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
  const [deleting, setDeleting] = useState(false)
  const [prefilling, setPrefilling] = useState(Boolean(prefillFromPostId))
  const [removedProducts, setRemovedProducts] = useState<{ id: number; name: string }[]>([])
  const [error, setError] = useState("")
  const [title, setTitle] = useState("")
  const [titleLoaded, setTitleLoaded] = useState(false)

  useEffect(() => {
    fetch(`/api/sheets/catalogue-posts/${postId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setTitle(data.post?.title ?? ""))
      .finally(() => setTitleLoaded(true))
  }, [postId])

  async function saveTitle(next: string) {
    try {
      const res = await fetch(`/api/sheets/catalogue-posts/${postId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? "Failed to save title")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save title")
    }
  }

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

  // Pre-fill from a reused post's tagged products, attaching one at a time,
  // then carrying forward each product's most recently placed pin (`pins`,
  // keyed by product id — see getLastPinPositions) so a repost doesn't make
  // the owner re-click every pin it already had. The `cancelled` guard
  // (checked before every attach) also protects against React 18 dev Strict
  // Mode's mount→cleanup→mount double-invoke: the first invocation's loop
  // always sees `cancelled === true` before it can issue a single attach, so
  // nothing gets double-attached.
  useEffect(() => {
    if (!prefillFromPostId) return
    let cancelled = false
    async function run() {
      try {
        const res = await fetch(`/api/sheets/catalogue-posts/${prefillFromPostId}`, { cache: "no-store" })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to load past post")
        const productIds: number[] = data.activeProductIds ?? []
        const pins: Record<number, { x: number; y: number }> = data.pins ?? {}
        if (!cancelled) setRemovedProducts(data.removedProducts ?? [])
        for (const productId of productIds) {
          if (cancelled) return
          const codeId = await attachProduct(productId)
          const pin = pins[productId]
          if (pin && !cancelled) await placePin(codeId, pin.x, pin.y)
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

  async function attachProduct(productId: number): Promise<number> {
    const res = await fetch(`/api/whatsapp/sends/${sendId}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? "Failed to attach product")
    await refresh()
    return data.code.id as number
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

  async function removeProduct(codeId: number) {
    setError("")
    try {
      const res = await fetch(`/api/whatsapp/sends/${sendId}/products/${codeId}`, { method: "DELETE" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to remove product")
      if (placingCodeId === codeId) setPlacingCodeId(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove product")
    }
  }

  // Deletes the whole post, not just this draft send — see
  // deleteCataloguePost: a send that already went out is detached (its
  // codes preserved, never reissued) rather than destroyed; an unsent draft
  // is hard-deleted along with its codes. Works the same whether this step
  // is a fresh upload or an existing post reopened for retagging.
  async function handleDeletePost() {
    if (!window.confirm("Delete this post? This can't be undone.")) return
    setDeleting(true)
    setError("")
    try {
      const res = await fetch(`/api/sheets/catalogue-posts/${postId}`, { method: "DELETE" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to delete post")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete post")
      setDeleting(false)
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
      window.alert("Sent to the WhatsApp group.")
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
      {prefilling && <p className="text-xs text-faint">Copying products from the previous post…</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="relative self-start">
          {mediaType === "video" ? (
            // Pins are a photo-only idea — a normalized (x, y) has no fixed
            // meaning against a moving frame, so a video post skips pin
            // placement entirely rather than offering a control that can't
            // mean anything. Products are still searched, tagged and coded
            // exactly the same; only pin placement is unavailable.
            <video src={mediaUrl} controls className="w-full rounded-xl border border-cream-border bg-black" />
          ) : (
            <>
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
                  Tap the photo to place a pin for {placingCode.code}
                </span>
              )}
            </>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => titleLoaded && saveTitle(title)}
            placeholder="Add a title…"
            rows={3}
            className="border border-cream-border rounded-lg px-2 py-1.5 text-sm font-semibold resize-none"
          />

          <div className="rounded-xl border border-cream-border bg-white p-3 flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-foreground">Products</h3>
            <ProductSearchPicker alreadyAddedIds={alreadyAddedIds} onPick={onPick} />
            {codes.length === 0 && removedProducts.length === 0 ? (
              <p className="text-xs text-faint">No products tagged yet.</p>
            ) : (
              <div className="flex flex-col gap-1.5 pt-1 border-t border-cream-border">
                {codes.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between gap-2 text-xs py-1.5 border-b border-cream-border last:border-b-0"
                  >
                    <span className="font-bold tabular-nums w-10 shrink-0">{c.code}</span>
                    <span className="flex-1 min-w-0 truncate">{c.productName}</span>
                    <span className="text-muted tabular-nums shrink-0">Rp {c.price.toLocaleString("id-ID")}</span>
                    {mediaType !== "video" && (
                      <button
                        type="button"
                        onClick={() => setPlacingCodeId(placingCodeId === c.id ? null : c.id)}
                        aria-label={placingCodeId === c.id ? "Cancel" : c.pointX !== null ? "Change pin" : "Place pin"}
                        title={placingCodeId === c.id ? "Cancel" : c.pointX !== null ? "Change pin" : "Place pin"}
                        className={`shrink-0 p-1.5 rounded-lg border ${
                          placingCodeId === c.id
                            ? "bg-brand text-white border-brand"
                            : c.pointX !== null
                              ? "border-cream-border text-brand"
                              : "border-cream-border text-muted"
                        }`}
                      >
                        {placingCodeId === c.id ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0Z" />
                            <circle cx="12" cy="10" r="3" />
                          </svg>
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removeProduct(c.id)}
                      aria-label="Remove"
                      title="Remove"
                      className="shrink-0 p-1.5 rounded-lg border border-red-200 text-red-600"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
                  </div>
                ))}
                {removedProducts.map((p) => (
                  <div key={`removed-${p.id}`} className="flex items-center gap-2 text-xs py-1.5 text-faint">
                    <span className="line-through truncate">{p.name}</span>
                    <span className="shrink-0">(no longer available)</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-cream-border bg-[#e5ddd5] p-3 flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold text-foreground">Message to the group</h3>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs bg-white rounded-lg p-3 border border-cream-border">
              {caption || "…"}
            </pre>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleDeletePost}
              disabled={deleting || sending}
              aria-label={deleting ? "Deleting…" : "Delete post"}
              title={deleting ? "Deleting…" : "Delete post"}
              className="p-2.5 rounded-lg border border-red-200 text-red-600 disabled:opacity-50"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onDone}
              disabled={deleting}
              aria-label="Save & close"
              title="Save & close"
              className="p-2.5 rounded-lg border border-cream-border text-muted disabled:opacity-50"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || deleting || codes.length === 0}
              aria-label={sending ? "Sending…" : "Send to group"}
              title={sending ? "Sending…" : "Send to group"}
              className="p-2.5 rounded-lg border border-transparent bg-brand text-white disabled:opacity-50"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
