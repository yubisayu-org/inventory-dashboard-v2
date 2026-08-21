"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import EventSelect from "@/components/EventSelect"

type Status = "queued" | "uploading" | "done" | "failed"

interface Job {
  id: string
  file: File
  status: Status
  detail: string
  postId?: number
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`

export default function UploadClient() {
  const [events, setEvents] = useState<string[]>([])
  const [event, setEvent] = useState("")
  const [store, setStore] = useState("")
  const [note, setNote] = useState("")
  const [jobs, setJobs] = useState<Job[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [dragging, setDragging] = useState(false)
  const [announce, setAnnounce] = useState(true)

  useEffect(() => {
    fetch("/api/whatsapp/posts/upload", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { events: string[] }) => {
        setEvents(data.events)
        setEvent((current) => current || data.events[0] || "")
      })
      .catch(() => setError("Could not load the events"))
  }, [])

  function add(files: FileList | null) {
    if (!files) return

    // Copied out of the FileList before the state update, not inside it. The
    // list belongs to the input, the change handler clears the input straight
    // after, and React runs the updater later — so reading it in there found an
    // empty list and queued nothing. A drop was unaffected, because a
    // DataTransfer's list is nobody's to clear, which is why dragging worked
    // and choosing did not.
    const chosen = [...files].map((file, i) => ({
      id: `${Date.now()}-${i}-${file.name}`,
      file,
      status: "queued" as Status,
      detail: kb(file.size),
    }))
    setJobs((all) => [...all, ...chosen])
  }

  function update(id: string, patch: Partial<Job>) {
    setJobs((all) => all.map((job) => (job.id === id ? { ...job, ...patch } : job)))
  }

  /**
   * One request per shelf, in order.
   *
   * A trip is forty racks over a shop connection that drops. Sending them one
   * at a time means a failure costs one rack rather than the batch, and the
   * ones already through are already shoppable — the owner does not have to
   * wait for the last photo before the first can be counted.
   */
  async function upload() {
    if (!event) return
    setBusy(true)
    setError("")

    for (const job of jobs) {
      if (job.status === "done") continue
      update(job.id, { status: "uploading", detail: "sending…" })

      const body = new FormData()
      body.append("file", job.file)
      body.append("event", event)
      body.append("store", store)
      body.append("note", note)
      body.append("announce", String(announce))

      try {
        const res = await fetch("/api/whatsapp/posts/upload", { method: "POST", body })
        // Read as text first: a 413 from a proxy, or an auth redirect to a login
        // page, is HTML — and calling .json() on it throws, which turned a
        // legible failure into "connection lost".
        const raw = await res.text()
        let payload: { id?: number; width?: number; height?: number; bytes?: number; error?: string } = {}
        try {
          payload = JSON.parse(raw)
        } catch {
          payload = { error: `${res.status} ${raw.slice(0, 60)}` }
        }
        if (!res.ok || !payload.id) {
          update(job.id, { status: "failed", detail: payload.error ?? `HTTP ${res.status}` })
          continue
        }
        update(job.id, {
          status: "done",
          postId: payload.id,
          detail: `${payload.width}×${payload.height} · ${kb(payload.bytes ?? 0)}`,
        })
      } catch (err) {
        update(job.id, { status: "failed", detail: (err as Error).message || "connection lost" })
      }
    }

    setBusy(false)
  }

  const pending = jobs.filter((j) => j.status !== "done").length

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Event</span>
          <EventSelect value={event} onChange={setEvent} events={events} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Store</span>
          <input
            value={store}
            onChange={(e) => setStore(e.target.value)}
            placeholder="Nishimatsuya"
            className="h-10 border border-cream-border rounded-lg px-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Note (optional)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="rak 2, lantai 3"
            className="h-10 border border-cream-border rounded-lg px-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
          />
        </label>
      </div>

      {/* The file field itself covers the box, invisible. A label pointed at a
          hidden input is the tidier markup and did not reliably open the dialog
          here; a click that lands on the input cannot fail to. Drops are handled
          on the wrapper, which the input does not intercept. */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          add(e.dataTransfer.files)
        }}
        className={`relative rounded-xl border border-dashed py-8 text-center text-sm text-muted transition-colors ${
          dragging ? "border-brand bg-brand/5" : "border-cream-border bg-white"
        }`}
      >
        <span className="block text-base mb-1">📷</span>
        Drag photos here, or click to choose — HEIC, JPEG or PNG
        <span className="block text-[11px] mt-1">
          Stored at 3000px. Sending the same photo through WhatsApp gives about 1280.
        </span>
        <input
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          onChange={(e) => {
            add(e.target.files)
            e.target.value = ""
          }}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-label="Choose shelf photos"
        />
      </div>

      {jobs.length > 0 ? (
        <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex items-center gap-3 px-4 py-2.5 border-b border-cream-border last:border-b-0"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-foreground truncate">{job.file.name}</span>
                <span className="block text-[11px] text-faint tabular-nums">{job.detail}</span>
              </span>
              {job.postId ? (
                <Link
                  href={`/dashboard/shop/${job.postId}`}
                  className="text-[11px] font-semibold text-brand shrink-0"
                >
                  open
                </Link>
              ) : null}
              <span
                className={`text-[11px] font-bold shrink-0 ${
                  job.status === "done"
                    ? "text-green-700"
                    : job.status === "failed"
                      ? "text-red-600"
                      : "text-faint"
                }`}
              >
                {job.status === "done"
                  ? "SAVED"
                  : job.status === "failed"
                    ? "FAILED"
                    : job.status === "uploading"
                      ? "SENDING"
                      : "QUEUED"}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* The bot sends what you upload, at the size it was stored — WhatsApp
          only shrinks what a phone app uploads, so a rack posted this way
          reaches the group sharper than one sent by hand. */}
      <label className="flex items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={announce}
          onChange={(e) => setAnnounce(e.target.checked)}
          className="mt-0.5 w-4 h-4 accent-brand"
        />
        <span>
          Post to the WhatsApp group
          <span className="block text-[11px] text-muted">
            Sent by the bot at full resolution, a few seconds after upload.
          </span>
        </span>
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={upload}
          disabled={busy || pending === 0 || !event}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {busy ? "Uploading…" : `Upload ${pending} shelf${pending === 1 ? "" : "/shelves"}`}
        </button>
        <button
          type="button"
          onClick={() => setJobs([])}
          disabled={busy || jobs.length === 0}
          className="rounded-xl border border-cream-border px-4 py-2.5 text-sm font-semibold disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  )
}
