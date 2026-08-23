"use client"

import { use } from "react"
import type { AnalyticsSummary, TopProduct, ProductRepeatRate, LoyalCustomer, EventRevenueTrend } from "@/lib/db"

function formatRp(n: number): string {
  return `Rp ${new Intl.NumberFormat("id-ID").format(n)}`
}

function pct(num: number, denom: number): number {
  if (denom <= 0) return 0
  return Math.min(100, Math.round((num / denom) * 100))
}

export default function AnalyticsClient({ dataPromise }: { dataPromise: Promise<AnalyticsSummary> }) {
  const data = use(dataPromise)

  return (
    <div className="flex flex-col gap-6">
      {/* Event revenue trend */}
      <Section title="Revenue by event" subtitle="All-time, chronological">
        <EventTrendTable rows={data.eventRevenueTrend} />
      </Section>

      {/* Top products */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Top products by units" subtitle="All events combined">
          <ProductTable rows={data.topProductsByUnits} valueKey="totalUnits" valueLabel="units" />
        </Section>
        <Section title="Top products by revenue" subtitle="All events combined">
          <ProductTable rows={data.topProductsByRevenue} valueKey="totalRevenue" valueLabel="revenue" formatValue={formatRp} />
        </Section>
      </div>

      {/* Repeat products */}
      <Section title="Repeat products" subtitle="Appeared in 2+ events — proven catalogue">
        <RepeatProductTable rows={data.productRepeatRate} />
      </Section>

      {/* Loyal customers */}
      <Section title="Loyal customers" subtitle="Ordered in 2+ events">
        <LoyalCustomerTable rows={data.loyalCustomers} />
      </Section>
    </div>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-faint">{subtitle}</span>
      </div>
      <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
        {children}
      </div>
    </section>
  )
}

function EventTrendTable({ rows }: { rows: EventRevenueTrend[] }) {
  if (rows.length === 0) return <EmptyState />
  const maxRevenue = Math.max(...rows.map((r) => r.totalRevenue), 1)
  return (
    <div className="divide-y divide-cream-border/60">
      {rows.map((r) => (
        <div key={r.eventName} className="px-4 py-3 flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium text-foreground truncate">{r.eventName}</span>
            <span className="tabular-nums text-muted-strong shrink-0">{formatRp(r.totalRevenue)}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <div className="flex-1 h-1.5 rounded-full bg-surface-sunken overflow-hidden">
              <div className="h-full bg-brand transition-all" style={{ width: `${pct(r.totalRevenue, maxRevenue)}%` }} />
            </div>
            <span className="shrink-0 tabular-nums">{r.totalUnits} units</span>
            <span className="shrink-0 text-faint">·</span>
            <span className="shrink-0 tabular-nums text-emerald-600">{formatRp(r.totalPaid)} paid</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function ProductTable({
  rows,
  valueKey,
  valueLabel,
  formatValue,
}: {
  rows: TopProduct[]
  valueKey: "totalUnits" | "totalRevenue"
  valueLabel: string
  formatValue?: (n: number) => string
}) {
  if (rows.length === 0) return <EmptyState />
  const maxVal = Math.max(...rows.map((r) => r[valueKey]), 1)
  const fmt = formatValue ?? ((n: number) => String(n))
  return (
    <div className="divide-y divide-cream-border/60">
      {rows.map((r, i) => (
        <div key={i} className="px-4 py-2.5 flex items-center gap-3">
          <span className="w-5 text-xs text-faint tabular-nums shrink-0">{i + 1}.</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-muted-strong truncate">
              {r.productName}
              {r.store && <span className="text-faint ml-1 text-xs">· {r.store}</span>}
            </p>
            <div className="mt-1 h-1 rounded-full bg-surface-sunken overflow-hidden">
              <div className="h-full bg-indigo-400 transition-all" style={{ width: `${pct(r[valueKey], maxVal)}%` }} />
            </div>
          </div>
          <div className="text-right shrink-0">
            <span className="text-sm tabular-nums text-muted-strong">{fmt(r[valueKey])}</span>
            <p className="text-xs text-faint">{r.totalEvents} {r.totalEvents === 1 ? "event" : "events"}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

function RepeatProductTable({ rows }: { rows: ProductRepeatRate[] }) {
  if (rows.length === 0) return <EmptyState />
  const maxEvents = Math.max(...rows.map((r) => r.eventCount), 1)
  return (
    <div className="divide-y divide-cream-border/60">
      {rows.map((r, i) => (
        <div key={i} className="px-4 py-2.5 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-muted-strong truncate">
              {r.productName}
              {r.store && <span className="text-faint ml-1 text-xs">· {r.store}</span>}
            </p>
            <p className="text-xs text-faint mt-0.5">{r.totalUnits} units · {formatRp(r.totalRevenue)}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-16 h-1.5 rounded-full bg-surface-sunken overflow-hidden">
              <div className="h-full bg-green-400 transition-all" style={{ width: `${pct(r.eventCount, maxEvents)}%` }} />
            </div>
            <span className="text-sm tabular-nums text-muted-strong w-16 text-right">
              {r.eventCount} {r.eventCount === 1 ? "event" : "events"}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function LoyalCustomerTable({ rows }: { rows: LoyalCustomer[] }) {
  if (rows.length === 0) return <EmptyState />
  const maxEvents = Math.max(...rows.map((r) => r.eventCount), 1)
  return (
    <div className="divide-y divide-cream-border/60">
      {rows.map((r, i) => (
        <div key={i} className="px-4 py-2.5 flex items-center gap-3">
          <span className="w-5 text-xs text-faint tabular-nums shrink-0">{i + 1}.</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-muted-strong truncate">@{r.customer}</p>
            <p className="text-xs text-faint mt-0.5">{r.totalUnits} units · {formatRp(r.totalSpend)}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-16 h-1.5 rounded-full bg-surface-sunken overflow-hidden">
              <div className="h-full bg-purple-400 transition-all" style={{ width: `${pct(r.eventCount, maxEvents)}%` }} />
            </div>
            <span className="text-sm tabular-nums text-muted-strong w-16 text-right">
              {r.eventCount} {r.eventCount === 1 ? "event" : "events"}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="p-8 text-center text-sm text-faint">No data yet.</div>
  )
}
