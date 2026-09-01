"use client"

import { useEffect, useState } from "react"
import { fetchJson } from "@/lib/api-fetch"
import { generateReceivedReport } from "@/lib/receiving-report-pdf"
import type { ReportCopy, ReportLayout } from "@/lib/receiving-report-groups"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import DateRangeField from "@/components/DateRangeField"
import EventSelect from "@/components/EventSelect"
import type { ReceivedReportItem } from "@/lib/db"

const INPUT_CLASS =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

// Today in Asia/Jakarta as YYYY-MM-DD (matches the server-side default), so the
// picker caps on the business day regardless of the browser's timezone.
function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date())
}

// The two pickers hold across visits: a trip is worked over days, and re-picking
// the same layout every morning is the kind of small friction that gets a wrong
// sheet printed. Browser-local and disposable — storage that refuses to work
// (private windows, blocked site data) just means the defaults.
const PREFS_KEY = "receiving-report-prefs"

function readPrefs(): { layout: ReportLayout; copy: ReportCopy } {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<{ layout: ReportLayout; copy: ReportCopy }>
      return {
        layout: saved.layout === "per-store" ? "per-store" : "per-box",
        copy: saved.copy === "staff" ? "staff" : "owner",
      }
    }
  } catch {
    // Fall through to the defaults.
  }
  return { layout: "per-box", copy: "owner" }
}

const SEG_BASE =
  "h-[38px] px-3 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-brand/30 first:rounded-l-lg last:rounded-r-lg"

function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex shrink-0 overflow-hidden rounded-lg border border-cream-border bg-white"
    >
      {options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={
            `${SEG_BASE} ${i > 0 ? "border-l border-cream-border" : ""} ` +
            (value === opt.value
              ? "bg-brand text-white font-medium"
              : "text-muted-strong hover:text-brand")
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

type Report = {
  event: string
  from: string | null
  to: string | null
  /** Echoed back so a message can name the parcel that had nothing in it. */
  receipt: string | null
  items: ReceivedReportItem[]
  totalUnits: number
}

export default function ReceivedReportControls() {
  const today = jakartaToday()
  const options = useSheetOptions()
  const [event, setEvent] = useState("")
  // Dates are optional: empty means every date for the selected event.
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  // Optional, and a prefix: "MNC" reports every sea box, "MNC-3109" one parcel.
  // Same field the dispatch document has, for the same reason — a report of a
  // whole trip is rarely what you want when a single box has just landed.
  const [receipt, setReceipt] = useState("")
  // A page per parcel while unpacking; a page per shop when handing over.
  const [layout, setLayout] = useState<ReportLayout>("per-box")
  const [copy, setCopy] = useState<ReportCopy>("owner")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // After mount, so the server and the first client render agree.
  useEffect(() => {
    const prefs = readPrefs()
    setLayout(prefs.layout)
    setCopy(prefs.copy)
  }, [])

  function remember(next: { layout: ReportLayout; copy: ReportCopy }) {
    setLayout(next.layout)
    setCopy(next.copy)
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(next))
    } catch {
      // A forgotten preference is not worth a failed download.
    }
  }

  // Only the per-store sheet is ever handed over, and only its heading has a
  // shop name to withhold. A per-box sheet is yours by definition.
  const effectiveCopy: ReportCopy = layout === "per-store" ? copy : "owner"

  // Order the range so a reversed selection still works (mirrors the API).
  const start = from && to ? (from <= to ? from : to) : from
  const end = from && to ? (from <= to ? to : from) : to

  async function download() {
    if (!event) return
    setLoading(true)
    setMessage(null)
    try {
      const query = new URLSearchParams({ event })
      if (start) query.set("from", start)
      if (end) query.set("to", end)
      const trimmedReceipt = receipt.trim()
      if (trimmedReceipt) query.set("receipt", trimmedReceipt)
      const report = await fetchJson<Report>(`/api/sheets/receiving-report?${query.toString()}`)
      if (report.items.length === 0) {
        const span =
          report.from && report.to
            ? report.from === report.to
              ? ` on ${report.from}`
              : ` between ${report.from} and ${report.to}`
            : ""
        setMessage(
          `No items were received for ${report.event}${span}` +
          `${report.receipt ? ` under ${report.receipt}` : ""}.`,
        )
        return
      }
      const blob = await generateReceivedReport({ ...report, layout, copy: effectiveCopy })
      const url = URL.createObjectURL(blob)
      try {
        const datePart =
          report.from && report.to
            ? report.from === report.to
              ? `-${report.from}`
              : `-${report.from}_to_${report.to}`
            : ""
        // The layout and the copy go in the name: two of these in one folder,
        // and the wrong one gets printed and handed over.
        const copyPart = layout === "per-store" ? `-${effectiveCopy}` : ""
        const a = document.createElement("a")
        a.href = url
        a.download = `received-${report.event}${datePart}-${layout}${copyPart}.pdf`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to generate report")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-cream-border bg-white p-4 flex items-end gap-2 sm:gap-3 flex-wrap">
      <div className="w-full sm:w-auto sm:flex-1 min-w-0 sm:min-w-[200px]">
        <EventSelect
          value={event}
          onChange={(v) => { setEvent(v); setMessage(null) }}
          events={options?.events ?? []}
          placeholder="Select event…"
        />
      </div>
      {/* One control for both shapes of the question: the day a parcel landed,
          or the span of a week being reconciled. Two native date inputs cannot
          express a range in one field. */}
      <DateRangeField
        value={{ from, to }}
        onChange={(next) => { setFrom(next.from); setTo(next.to) }}
        max={today}
        className="flex-1 min-w-0 sm:min-w-[200px]"
      />
      <input
        type="text"
        value={receipt}
        onChange={(e) => setReceipt(e.target.value)}
        aria-label="Parcel receipt (optional)"
        placeholder="Receipt (optional)"
        className={`${INPUT_CLASS} h-[38px] flex-1 min-w-0 sm:min-w-[160px]`}
      />
      <Segmented
        label="Report layout"
        value={layout}
        onChange={(v) => remember({ layout: v, copy })}
        options={[
          { value: "per-box", label: "Per box" },
          { value: "per-store", label: "Per store" },
        ]}
      />
      {/* Only the handed-over sheet has anything to withhold. */}
      {layout === "per-store" && (
        <Segmented
          label="Copy"
          value={copy}
          onChange={(v) => remember({ layout, copy: v })}
          options={[
            { value: "owner", label: "Owner" },
            { value: "staff", label: "Staff" },
          ]}
        />
      )}
      <button
        type="button"
        onClick={download}
        disabled={loading || !event}
        aria-label="Download PDF"
        title={event ? "Download PDF" : "Select an event first"}
        className="h-[38px] w-[38px] sm:w-auto shrink-0 rounded-lg border border-cream-border bg-white sm:px-4 text-sm font-medium text-muted-strong transition-colors hover:border-brand hover:text-brand disabled:opacity-50 flex items-center justify-center"
      >
        <svg className="sm:hidden" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <span className="hidden sm:inline">{loading ? "Preparing…" : "Download PDF"}</span>
      </button>
      {message && <span className="text-sm text-muted basis-full">{message}</span>}
    </div>
  )
}
