"use client"

import { useCallback, useEffect, useState } from "react"
import EventSelect from "@/components/EventSelect"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { displayIg } from "@/lib/format"
import {
  applyNoticeOverrides,
  NOTICE_TOKENS_FOR,
  type NoticeKey,
  type NoticeOverride,
  type NoticeTemplate,
} from "@/lib/notice-templates"

type Announcement = {
  id: number
  title: string
  body: string
  createdAt: string
}

const MAX_TITLE = 120
const MAX_BODY = 4000

/**
 * The tokens a trip notice can actually answer for.
 *
 * Every recipient's own figures are known here, and nothing else is: an
 * {amount} or a {refundAmount} belongs to one payment or one refund, not to
 * forty people at once. A template needing one of those would send a sentence
 * with a hole in it, so it is not offered.
 */
const TRIP_TOKENS = new Set(["{event}", "{customer}", "{total}", "{outstanding}"])

function usableTemplates(overrides: Partial<Record<NoticeKey, NoticeOverride>> | null): NoticeTemplate[] {
  return applyNoticeOverrides(overrides).filter(
    (t) => t.key.startsWith("inbox_")
      && (NOTICE_TOKENS_FOR[t.key] ?? []).every((token) => TRIP_TOKENS.has(token)),
  )
}

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

      <TripNotice />

      <section className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">
          {editingId ? "Edit announcement" : "New announcement"}
        </h2>
        <p className="text-[11px] text-faint -mt-1">
          Seen by every customer. For news about one trip, use the box above.
        </p>

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

// ─── Notice for one trip ─────────────────────────────────────────────────────

type Recipient = {
  customer: string
  units: number
  unshipped: number
  total: number
  outstanding: number
}

/**
 * One notice, to everybody on one trip.
 *
 * The announcement below this reaches every customer there is, and the Send
 * notice button on an invoice reaches exactly one. A cargo delay is neither:
 * telling everybody includes people with no order on that trip, and telling
 * them one at a time is forty invoices opened by hand.
 *
 * The list of who it reaches is shown before it is sent, not counted after.
 * Forty notices is not a thing to undo.
 */
function TripNotice() {
  const options = useSheetOptions()
  const [event, setEvent] = useState("")
  const [skipShipped, setSkipShipped] = useState(true)
  const [onlyUnpaid, setOnlyUnpaid] = useState(false)
  const [templates, setTemplates] = useState<NoticeTemplate[]>([])
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [recipients, setRecipients] = useState<Recipient[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")
  const [sentTo, setSentTo] = useState<number | null>(null)

  useEffect(() => {
    if (!event) { setRecipients(null); return }
    let live = true
    setError("")
    fetch(
      `/api/announcements/event?event=${encodeURIComponent(event)}`
        + `&skipShipped=${skipShipped ? "1" : "0"}&onlyUnpaid=${onlyUnpaid ? "1" : "0"}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((d: { recipients?: Recipient[]; error?: string }) => {
        if (!live) return
        if (d.error) setError(d.error)
        else setRecipients(d.recipients ?? [])
      })
      .catch(() => { if (live) setError("Couldn't load who this would reach.") })
    return () => { live = false }
  }, [event, skipShipped, onlyUnpaid])

  // The owner's own wording, so what she edited in Settings is what she sends.
  useEffect(() => {
    fetch("/api/sheets/notice-templates", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { overrides?: Partial<Record<NoticeKey, NoticeOverride>> }) => {
        setTemplates(usableTemplates(d.overrides ?? null))
      })
      .catch(() => setTemplates(usableTemplates(null)))
  }, [])

  const ready = Boolean(event) && title.trim() !== "" && body.trim() !== "" && (recipients?.length ?? 0) > 0

  async function send() {
    setSending(true)
    setError("")
    try {
      const res = await fetch("/api/announcements/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, title, body, skipShipped, onlyUnpaid }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to send")
      setSentTo(data.sent ?? 0)
      setTitle("")
      setBody("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send")
    } finally {
      setSending(false)
    }
  }

  const shown = showAll ? recipients ?? [] : (recipients ?? []).slice(0, 8)

  return (
    <section className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Notice for one trip</h2>
        <p className="text-[11px] text-faint">
          Lands in the inbox of everyone who ordered on that trip, and nobody else. Use{" "}
          <code className="bg-surface-sunken px-1 rounded">{"{event}"}</code> in the text and it
          fills itself in.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">Trip</span>
          <EventSelect value={event} onChange={(v) => { setEvent(v); setSentTo(null) }}
            events={options?.events ?? []} placeholder="Pick a trip" />
        </div>
        <div className="flex flex-col gap-2 md:pt-6">
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={skipShipped} disabled={sending}
              onChange={(e) => setSkipShipped(e.target.checked)} className="accent-brand mt-0.5" />
            <span className="text-xs text-muted-strong">
              Skip whoever already has their parcel
              <span className="block text-[11px] text-faint">
                Their box is not in that cargo, so a delay is not their news.
              </span>
            </span>
          </label>
          {/* A reminder is only news to somebody who owes. Sending it to a
              customer who has paid is the fastest way to teach her to ignore
              the next one. */}
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={onlyUnpaid} disabled={sending}
              onChange={(e) => { setOnlyUnpaid(e.target.checked); setSentTo(null) }}
              className="accent-brand mt-0.5" />
            <span className="text-xs text-muted-strong">
              Only those who still owe
              <span className="block text-[11px] text-faint">
                For a payment reminder. Their own figures fill {"{outstanding}"}.
              </span>
            </span>
          </label>
        </div>
      </div>

      {event && recipients && (
        <div className="rounded-lg border border-cream-border bg-surface-muted p-3 flex flex-col gap-1.5">
          <div className="text-xs font-medium text-muted-strong">
            {recipients.length === 0
              ? "Nobody on this trip is waiting for anything."
              : `Reaches ${recipients.length} customer${recipients.length === 1 ? "" : "s"}`}
          </div>
          {recipients.length > 0 && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {shown.map((r) => (
                  <span key={r.customer}
                    title={`${r.unshipped} of ${r.units} still to come`}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-white border border-cream-border text-muted-strong">
                    {displayIg(r.customer)}
                    {onlyUnpaid && r.outstanding > 0 && (
                      <span className="text-faint"> · {r.outstanding.toLocaleString("id-ID")}</span>
                    )}
                  </span>
                ))}
              </div>
              {recipients.length > shown.length && (
                <button type="button" onClick={() => setShowAll(true)}
                  className="self-start text-[11px] text-brand hover:underline">
                  Show the other {recipients.length - shown.length}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* A starting point, not a rail: what it writes is ordinary text she can
          edit before sending, and the notice is hers either way. */}
      {templates.length > 0 && (
        <div className="flex flex-col gap-1">
          <label htmlFor="trip-template" className="text-xs text-muted">Start from a template</label>
          <select
            id="trip-template"
            className={inputCls}
            value=""
            disabled={sending}
            onChange={(e) => {
              const picked = templates.find((t) => t.key === e.target.value)
              if (!picked) return
              setTitle(picked.title)
              setBody(picked.body)
              setSentTo(null)
              // A reminder is for people who owe, so the filter follows the
              // wording rather than waiting to be remembered.
              if (picked.key === "inbox_waiting_payment" || picked.key === "inbox_invoice_due") {
                setOnlyUnpaid(true)
              }
            }}
          >
            <option value="">Write it myself</option>
            {templates.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
          <span className="text-[11px] text-faint">
            Edited in Settings. {"{outstanding}"} and {"{total}"} fill with each person&apos;s own
            figures, so one notice can name forty different amounts.
          </span>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="trip-title" className="text-xs text-muted">Title</label>
        <input id="trip-title" className={inputCls} value={title} maxLength={MAX_TITLE}
          onChange={(e) => { setTitle(e.target.value); setSentTo(null) }}
          placeholder="{event} is running late" />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="trip-body" className="text-xs text-muted">Message</label>
        <textarea id="trip-body" className={`${inputCls} min-h-[90px] resize-y`} value={body}
          maxLength={MAX_BODY}
          onChange={(e) => { setBody(e.target.value); setSentTo(null) }}
          placeholder="The cargo for {event} is held up at customs. Nothing is lost — we will tell you the moment it moves." />
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {sentTo !== null && (
        <p className="text-xs text-green-700">
          Sent to {sentTo} customer{sentTo === 1 ? "" : "s"}.
        </p>
      )}

      <div className="flex justify-end">
        <button type="button" onClick={send} disabled={!ready || sending}
          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-dark disabled:opacity-50 transition-colors">
          {sending ? "Sending…" : `Send to ${recipients?.length ?? 0}`}
        </button>
      </div>
    </section>
  )
}
