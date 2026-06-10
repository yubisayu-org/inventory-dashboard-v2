"use client"

// error.tsx must be a Client Component (Next.js requirement for error boundaries).
// It cannot render async Server Components (like Sidebar), so we render a plain
// fallback — the surrounding layout (sidebar, nav) is provided by the parent
// layout.tsx and stays mounted during error boundary renders.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 flex items-center justify-between gap-3">
      <span>{error.message || "Failed to load"}</span>
      <button
        onClick={reset}
        className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-100 transition-colors shrink-0"
      >
        Retry
      </button>
    </div>
  )
}
