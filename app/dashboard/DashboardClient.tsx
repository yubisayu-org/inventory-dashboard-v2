"use client"

import { use } from "react"
import Link from "next/link"
import type { DashboardSummary, DashboardEvent } from "@/lib/db"

function formatRp(n: number): string {
  return `Rp ${new Intl.NumberFormat("id-ID").format(n)}`
}

function pct(num: number, denom: number): number {
  if (denom <= 0) return 0
  return Math.min(100, Math.round((num / denom) * 100))
}

type ActionItem = {
  count: number
  label: string
  href: string
  tone: "yellow" | "blue" | "orange" | "green" | "red" | "purple"
}

const TONE_CLASSES: Record<ActionItem["tone"], string> = {
  yellow: "bg-yellow-50 border-yellow-200 text-yellow-800 hover:bg-yellow-100",
  blue: "bg-blue-50 border-blue-200 text-blue-800 hover:bg-blue-100",
  orange: "bg-orange-50 border-orange-200 text-orange-800 hover:bg-orange-100",
  green: "bg-green-50 border-green-200 text-green-800 hover:bg-green-100",
  red: "bg-red-50 border-red-200 text-red-800 hover:bg-red-100",
  purple: "bg-purple-50 border-purple-200 text-purple-800 hover:bg-purple-100",
}

export default function DashboardClient({
  summaryPromise,
}: {
  summaryPromise: Promise<DashboardSummary>
}) {
  // Resolves the promise streamed from the server component. While it's
  // pending the parent <Suspense> shows the loading card; on rejection it
  // throws to the route's error boundary (error.tsx), which offers a retry.
  const summary = use(summaryPromise)

  const items: ActionItem[] = ([
    { count: summary.actionQueue.overpaymentCandidates, label: "overpayments to refund", href: "/dashboard/refunds", tone: "yellow" },
    { count: summary.actionQueue.refundsReadyToTransfer, label: "refunds ready to transfer", href: "/dashboard/refunds", tone: "orange" },
    { count: summary.actionQueue.refundsPending, label: "refunds need WhatsApp message", href: "/dashboard/refunds", tone: "yellow" },
    { count: summary.actionQueue.refundsAwaitingBankInfo, label: "refunds awaiting bank info", href: "/dashboard/refunds", tone: "blue" },
    { count: summary.actionQueue.itemsPendingPurchase, label: "items pending purchase", href: "/dashboard/shopping-list", tone: "green" },
    { count: summary.actionQueue.itemsPendingArrival, label: "items pending arrival", href: "/dashboard/arrival-list", tone: "blue" },
    { count: summary.actionQueue.customersReadyToShip, label: "customers ready to ship", href: "/dashboard/ship", tone: "purple" },
  ] satisfies ActionItem[]).filter((item) => item.count > 0)

  return (
    <div className="flex flex-col gap-6">
      {/* Action queue */}
      {items.length === 0 ? (
        <div className="rounded-xl border border-cream-border bg-white p-8 text-center">
          <div className="text-2xl mb-2">🎉</div>
          <p className="text-sm font-medium text-foreground">All caught up</p>
          <p className="text-xs text-gray-500 mt-1">No pending actions across the pipeline.</p>
        </div>
      ) : (
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-foreground">Action queue</h2>
            <span className="text-xs text-gray-400">{items.reduce((s, i) => s + i.count, 0)} pending</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {items.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className={`flex items-center justify-between gap-3 px-4 py-3 rounded-lg border transition-colors ${TONE_CLASSES[item.tone]}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-2xl font-bold tabular-nums shrink-0">{item.count}</span>
                  <span className="text-sm truncate">{item.label}</span>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-60">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Active events */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-foreground">Active events</h2>
          <span className="text-xs text-gray-400">
            {summary.events.length} {summary.events.length === 1 ? "event" : "events"} in pipeline
          </span>
        </div>
        {summary.events.length === 0 ? (
          <div className="rounded-xl border border-cream-border bg-white p-6 text-center text-sm text-gray-400">
            No active events.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {summary.events.map((ev) => <EventCard key={ev.name} event={ev} />)}
          </div>
        )}
      </section>
    </div>
  )
}

function EventCard({ event }: { event: DashboardEvent }) {
  const stages = [
    { label: "Bought", num: event.totalBought, denom: event.totalUnits, color: "bg-green-500" },
    { label: "Arrived", num: event.totalArrived, denom: event.totalUnits, color: "bg-blue-500" },
    { label: "Shipped", num: event.totalShipped, denom: event.totalUnits, color: "bg-purple-500" },
  ]

  return (
    <div className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-foreground truncate">{event.name}</span>
        {event.eta && <span className="text-xs text-gray-400 shrink-0">ETA: {event.eta}</span>}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
        <span><span className="font-medium text-foreground">{event.orderCount}</span> orders</span>
        <span><span className="font-medium text-foreground">{event.customerCount}</span> customers</span>
        <span><span className="font-medium text-foreground">{event.totalUnits}</span> units</span>
        <span className="ml-auto text-foreground font-medium tabular-nums">{formatRp(event.totalSubtotal)}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        {stages.map((s) => {
          const p = pct(s.num, s.denom)
          return (
            <div key={s.label} className="flex items-center gap-2 text-xs">
              <span className="w-16 shrink-0 text-gray-500">{s.label}</span>
              <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                <div className={`h-full ${s.color} transition-all`} style={{ width: `${p}%` }} />
              </div>
              <span className="w-20 shrink-0 text-right tabular-nums text-gray-600">
                {s.num}<span className="text-gray-400">/{s.denom}</span>
                <span className="text-gray-400 ml-1">({p}%)</span>
              </span>
            </div>
          )
        })}
        <div className="flex items-center gap-2 text-xs pt-1 mt-1 border-t border-cream-border/60">
          <span className="w-16 shrink-0 text-gray-500">Paid</span>
          <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct(event.totalPaid, event.totalSubtotal)}%` }} />
          </div>
          <span className="w-auto shrink-0 text-right tabular-nums text-gray-600">
            <span className="text-foreground font-medium">{formatRp(event.totalPaid)}</span>
            <span className="text-gray-400"> / {formatRp(event.totalSubtotal)}</span>
          </span>
        </div>
      </div>
    </div>
  )
}
