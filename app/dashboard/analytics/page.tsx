import { Suspense } from "react"
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import AnalyticsClient from "./AnalyticsClient"
import { getAnalyticsSummary } from "@/lib/db"

export const dynamic = "force-dynamic"

export default function AnalyticsPage() {
  const dataPromise = getAnalyticsSummary()

  return (
    <PageShell>
      <PageHeader title="Analytics" subtitle="Trends across all events to guide future planning" />
      <Suspense fallback={<div className="rounded-xl border border-cream-border bg-white p-12 text-center text-sm text-gray-400">Loading…</div>}>
        <AnalyticsClient dataPromise={dataPromise} />
      </Suspense>
    </PageShell>
  )
}
