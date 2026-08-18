"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"

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
  const picker = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    fetch("/api/whatsapp/posts/upload", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { events: string[] }) => {
        setEvents(data.events)
        setEvent((current) => current || data.events[0] || "")
      })
      .catch(() => setError("Could not load the trips"))
  }, [])

  function add(files: FileList | null) {
    if (!files) return
    setJobs((all) => [
      ...all,
      ...[...files].map((file, i) => ({
        id: `${Date.now()}-${i}-${file.name}`,
        file,
        status: "queued" as Status,
        detail: kb(file.size),
      })),
    ])
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

      try {
        const res = await fetch("/api/whatsapp/posts/upload", { method: "POST", body })
        const payload = await res.json()
        if (!res.ok) {
          update(job.id, { status: "failed", detail: payload.error ?? "failed" })
          continue
        }
        update(job.id, {
          status: "done",
          postId: payload.id,
          detail: `${payload.width}×${payload.height} · ${kb(payload.bytes)}`,
        })
      } catch {
        update(job.id, { status: "failed", detail: "connection lost" })
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
          <span className="text-xs text-gray-500">Trip</span>
          <select
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            className="border border-cream-border rounded-lg px-2 py-2 text-sm bg-white"
          >
            {events.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Store</span>
          <input
            value={store}
            onChange={(e) => setStore(e.target.value)}
            placeholder="Nishimatsuya"
            className="border border-cream-border rounded-lg px-2 py-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Note (optional)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="rak 2, lantai 3"
            className="border border-cream-border rounded-lg px-2 py-2 text-sm"
          />
        </label>
      </div>

      <button
        type="button"
        onClick={() => picker.current?.click()}
        className="rounded-xl border border-dashed border-cream-border bg-white py-8 text-sm text-gray-500"
      >
        <span className="block text-base mb-1">📷</span>
        Choose photos — HEIC, JPEG or PNG
        <span className="block text-[11px] mt-1">
          Stored at 3000px. Sending the same photo through WhatsApp gives about 1280.
        </span>
      </button>
      <input
        ref={picker}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        hidden
        onChange={(e) => {
          add(e.target.files)
          e.target.value = ""
        }}
      />

      {jobs.length > 0 ? (
        <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex items-center gap-3 px-4 py-2.5 border-b border-cream-border last:border-b-0"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-foreground truncate">{job.file.name}</span>
                <span className="block text-[11px] text-gray-400 tabular-nums">{job.detail}</span>
              </span>
              {job.postId ? (
                <Link
                  href={`/dashboard/wa-posts/${job.postId}`}
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
                      : "text-gray-400"
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
