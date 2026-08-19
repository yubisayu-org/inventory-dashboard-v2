"use client"

import { useEffect, useState } from "react"
import EventSelect from "@/components/EventSelect"
import type { RepostCandidate } from "@/lib/db/wa-sends"

/** "2026-06-12T10:00:00.000Z" -> "12 Jun", matching the spec's example
 *  library-card format ("LSJP · 12 Jun · 7 order"). */
function formatLastSent(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "short" })
}

/**
 * The upload step of the WhatsApp product-post composer: pick a photo (new
 * or a past post to repost) plus a trip and a title, and create the
 * `wa_sends` row Task 9's product step continues from.
 *
 * `onCreated`'s `prefillFromPostId` is only set for the "Pakai post lama"
 * path — it's how the product step knows to pre-attach a past post's
 * already-tagged products instead of starting from a blank slate.
 */
export default function ComposerUploadStep({
  activeEvents,
  onCreated,
}: {
  activeEvents: string[]
  onCreated: (sendId: number, mediaUrl: string, prefillFromPostId?: number) => void
}) {
  const [tab, setTab] = useState<"new" | "reuse">("new")

  return (
    <div className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-4">
      <div className="flex gap-2">
        <button
          onClick={() => setTab("new")}
          className={`px-3 py-1.5 rounded-lg text-sm border ${tab === "new" ? "bg-brand text-white border-brand" : "border-cream-border text-gray-500"}`}
        >
          Foto baru
        </button>
        <button
          onClick={() => setTab("reuse")}
          className={`px-3 py-1.5 rounded-lg text-sm border ${tab === "reuse" ? "bg-brand text-white border-brand" : "border-cream-border text-gray-500"}`}
        >
          Pakai post lama
        </button>
      </div>
      {tab === "new" ? (
        <NewPhotoTab activeEvents={activeEvents} onCreated={onCreated} />
      ) : (
        <ReusePostTab activeEvents={activeEvents} onCreated={onCreated} />
      )}
    </div>
  )
}

function NewPhotoTab({
  activeEvents,
  onCreated,
}: {
  activeEvents: string[]
  onCreated: (sendId: number, mediaUrl: string, prefillFromPostId?: number) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [event, setEvent] = useState("")
  const [title, setTitle] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  async function submit() {
    if (!file) { setError("Pilih foto dulu"); return }
    if (!event) { setError("Pilih trip"); return }
    if (!title.trim()) { setError("Judul wajib diisi"); return }
    setSubmitting(true); setError("")
    try {
      // 1. Resize to the same 3000px/quality-70 cap a shelf gets, server-side
      //    (sharp isn't available in the browser) — see
      //    app/api/whatsapp/composer/resize-photo/route.ts for why this is a
      //    separate round trip rather than folded into the upload below.
      const resizeForm = new FormData()
      resizeForm.set("file", file)
      const resizeRes = await fetch("/api/whatsapp/composer/resize-photo", { method: "POST", body: resizeForm })
      if (!resizeRes.ok) {
        const data = await resizeRes.json().catch(() => ({}))
        throw new Error(data.error ?? "Gagal memproses foto")
      }
      const resizedBlob = await resizeRes.blob()
      const resizedFile = new File([resizedBlob], file.name, { type: resizedBlob.type })

      // 2. Create the underlying catalogue_posts row, exactly as the plain
      //    UploadForm above does — no products tagged yet (that's Task 9),
      //    and no free-text caption (wa_sends.title is the independent field
      //    a product post actually uses).
      const postForm = new FormData()
      postForm.set("file", resizedFile)
      postForm.set("caption", "")
      postForm.set("productIds", "[]")
      const postRes = await fetch("/api/sheets/catalogue-posts", { method: "POST", body: postForm })
      const postData = await postRes.json()
      if (!postRes.ok) throw new Error(postData.error ?? "Gagal membuat post")

      // 3. Start the send.
      const sendRes = await fetch("/api/whatsapp/sends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: postData.id, event, title: title.trim() }),
      })
      const sendData = await sendRes.json()
      if (!sendRes.ok) throw new Error(sendData.error ?? "Gagal membuat send")

      // The create-post route only returns { success, id } — no media_url —
      // so the product step's preview uses a client-side object URL of the
      // same File the user picked. Display-only: never re-uploaded or read
      // server-side, so it doesn't matter that it isn't the stored URL.
      onCreated(sendData.id, URL.createObjectURL(file))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        type="file"
        accept="image/*"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-sm"
      />
      <EventSelect value={event} onChange={setEvent} events={activeEvents} placeholder="Pilih trip…" />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Judul"
        className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
      <button
        onClick={submit}
        disabled={submitting}
        className="self-start px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50"
      >
        {submitting ? "Memproses…" : "Lanjut ke produk"}
      </button>
    </div>
  )
}

function ReusePostTab({
  activeEvents,
  onCreated,
}: {
  activeEvents: string[]
  onCreated: (sendId: number, mediaUrl: string, prefillFromPostId?: number) => void
}) {
  const [library, setLibrary] = useState<RepostCandidate[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [selected, setSelected] = useState<RepostCandidate | null>(null)
  const [event, setEvent] = useState("")
  const [title, setTitle] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/whatsapp/sends/library", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error)
        setLibrary(data.library ?? [])
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Gagal memuat"))
  }, [])

  function pick(card: RepostCandidate) {
    setSelected(card)
    setEvent(activeEvents[0] ?? "")
    setTitle(card.title)
    setError("")
  }

  async function submit() {
    if (!selected) return
    if (!event) { setError("Pilih trip"); return }
    if (!title.trim()) { setError("Judul wajib diisi"); return }
    setSubmitting(true); setError("")
    try {
      const sendRes = await fetch("/api/whatsapp/sends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: selected.postId, event, title: title.trim() }),
      })
      const sendData = await sendRes.json()
      if (!sendRes.ok) throw new Error(sendData.error ?? "Gagal membuat send")
      onCreated(sendData.id, selected.mediaUrl, selected.postId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal")
    } finally {
      setSubmitting(false)
    }
  }

  if (loadError) return <p className="text-sm text-red-500">{loadError}</p>
  if (library === null) return <p className="text-sm text-gray-400">Loading…</p>
  if (library.length === 0) return <p className="text-sm text-gray-400">Belum ada post yang pernah dikirim.</p>

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {library.map((card) => (
          <button
            key={card.postId}
            onClick={() => pick(card)}
            className={`flex flex-col gap-1.5 rounded-xl border p-2 text-left ${selected?.postId === card.postId ? "border-brand" : "border-cream-border"}`}
          >
            <img src={card.mediaUrl} alt="" className="w-full aspect-square object-cover rounded-lg" />
            <div className="text-xs font-medium text-foreground truncate">{card.title}</div>
            <div className="text-xs text-gray-400">
              {card.lastEvent} · {formatLastSent(card.lastSentAt)} · {card.orderCount} order
            </div>
          </button>
        ))}
      </div>
      {selected && (
        <div className="flex flex-col gap-3 border-t border-cream-border pt-3">
          <EventSelect value={event} onChange={setEvent} events={activeEvents} placeholder="Pilih trip…" />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Judul"
            className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            onClick={submit}
            disabled={submitting}
            className="self-start px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50"
          >
            {submitting ? "Memproses…" : "Lanjut ke produk"}
          </button>
        </div>
      )}
    </div>
  )
}
