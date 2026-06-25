"use client"

import { useState } from "react"
import { fetchJson } from "@/lib/api-fetch"
import { generateReceivedReport } from "@/lib/receiving-report-pdf"
import type { ReceivedReportItem } from "@/lib/db"

const INPUT_CLASS =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

// Today in Asia/Jakarta as YYYY-MM-DD (matches the server-side default), so the
// picker opens on the business day regardless of the browser's timezone.
function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date())
}

type Report = { from: string; to: string; items: ReceivedReportItem[]; totalUnits: number }

export default function ReceivedReportControls() {
  const today = jakartaToday()
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Order the range so a reversed selection still works (mirrors the API).
  const start = from <= to ? from : to
  const end = from <= to ? to : from

  async function download() {
    setLoading(true)
    setMessage(null)
    try {
      const report = await fetchJson<Report>(
        `/api/sheets/receiving-report?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`,
      )
      if (report.items.length === 0) {
        setMessage(
          report.from === report.to
            ? `No items were received on ${report.from}.`
            : `No items were received between ${report.from} and ${report.to}.`,
        )
        return
      }
      const blob = await generateReceivedReport(report)
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement("a")
        a.href = url
        a.download =
          report.from === report.to
            ? `received-${report.from}.pdf`
            : `received-${report.from}_to_${report.to}.pdf`
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
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <label className="text-sm text-gray-600">Received report</label>
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={from}
          max={today}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="From date"
          className={INPUT_CLASS}
        />
        <span className="text-sm text-gray-400">to</span>
        <input
          type="date"
          value={to}
          max={today}
          onChange={(e) => setTo(e.target.value)}
          aria-label="To date"
          className={INPUT_CLASS}
        />
      </div>
      <button
        type="button"
        onClick={download}
        disabled={loading || !from || !to}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark disabled:opacity-50"
      >
        {loading ? "Preparing…" : "Download PDF"}
      </button>
      {message && <span className="text-sm text-gray-500">{message}</span>}
    </div>
  )
}
