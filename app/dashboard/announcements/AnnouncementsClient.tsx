"use client"

import { useCallback, useEffect, useState } from "react"

type Announcement = {
  id: number
  title: string
  body: string
  createdAt: string
}

const MAX_TITLE = 120
const MAX_BODY = 4000

const inputCls =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

function publishedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default function AnnouncementsClient() {
  const [items, setItems] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  /** Null while writing a new one; an id while editing an existing one. */
  const [editingId, setEditingId] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/announcements", { cache: "no-store" })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setItems(data.announcements)
      setError("")
    } catch {
      setError("Couldn't load announcements. Reload to try again.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function reset() {
    setEditingId(null)
    setTitle("")
    setBody("")
  }

  async function save() {
    if (!title.trim() || !body.trim()) {
      setError("A title and a message are both required.")
      return
    }
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/announcements", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId ?? undefined, title, body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to save")
      reset()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setBusy(false)
    }
  }

  async function remove(a: Announcement) {
    // Said plainly: this is not a recall. Anyone who already read it, read it.
    if (
      !confirm(
        `Delete "${a.title}"?\n\nIt disappears from every customer's inbox. Anyone who has already read it has already read it.`,
      )
    ) {
      return
    }
    setBusy(true)
    setError("")
    try {
      const res = await fetch(`/api/announcements?id=${a.id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to delete")
      if (editingId === a.id) reset()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete")
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className="text-sm text-muted">Loading…</p>

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">
          {editingId ? "Edit announcement" : "New announcement"}
        </h2>

        <div className="flex flex-col gap-1">
          <label htmlFor="ann-title" className="text-xs text-muted">
            Title
          </label>
          <input
            id="ann-title"
            className={inputCls}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={MAX_TITLE}
            placeholder="Closed for Lebaran"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="ann-body" className="text-xs text-muted">
            Message
          </label>
          <textarea
            id="ann-body"
            className={`${inputCls} min-h-32 resize-y`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={MAX_BODY}
            placeholder="Orders placed after 5 April ship the week of 14 April."
          />
          <span className="text-xs text-faint self-end tabular-nums">
            {body.length} / {MAX_BODY}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {busy ? "Saving…" : editingId ? "Save changes" : "Publish"}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="px-4 py-2 rounded-lg border border-cream-border text-muted-strong text-sm font-medium hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
          )}
          <p className="text-xs text-muted ml-auto">
            Published immediately, to every signed-in customer.
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">
          Published ({items.length})
        </h2>
        {items.length === 0 ? (
          <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-faint">
            Nothing published yet.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((a) => (
              <div
                key={a.id}
                className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-1"
              >
                <div className="flex items-start gap-3">
                  <span className="text-sm font-semibold text-foreground">{a.title}</span>
                  <span className="text-xs text-faint whitespace-nowrap ml-auto">
                    {publishedAt(a.createdAt)}
                  </span>
                </div>
                <p className="text-sm text-muted-strong whitespace-pre-wrap">{a.body}</p>
                <div className="flex gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(a.id)
                      setTitle(a.title)
                      setBody(a.body)
                      window.scrollTo({ top: 0, behavior: "smooth" })
                    }}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(a)}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-lg border border-red-300 text-red-700 text-xs font-medium hover:bg-red-100 disabled:opacity-50 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
