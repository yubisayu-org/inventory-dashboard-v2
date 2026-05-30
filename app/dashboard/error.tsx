"use client"

import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"

// Catches a rejected dashboard-summary query. Rendered inside the shell so the
// sidebar stays put; reset() re-renders the page segment, which re-runs the
// query — the equivalent of the old inline "Retry" button.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <PageShell>
      <PageHeader title="Dashboard" subtitle="What needs your attention" />
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 flex items-center justify-between gap-3">
        <span>{error.message || "Failed to load"}</span>
        <button
          onClick={reset}
          className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-100 transition-colors shrink-0"
        >
          Retry
        </button>
      </div>
    </PageShell>
  )
}
