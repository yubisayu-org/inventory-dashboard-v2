"use client"

import { useEffect, useState } from "react"
import type { InvoiceResult } from "@/lib/db"
import { copyToClipboard } from "@/lib/clipboard"

type InvoiceCopyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "copied" }
  | { status: "error"; message: string }

/**
 * Per-row "copy invoice message" button. Fetches the customer's invoices, picks
 * the one for the given event (a customer can have several events, so we match
 * on eventId rather than taking the latest), and copies its message.
 */
export default function CopyInvoiceButton({ customer, event }: { customer: string; event: string }) {
  const [state, setState] = useState<InvoiceCopyState>({ status: "idle" })

  useEffect(() => {
    if (state.status === "idle") return
    const delay = state.status === "error" ? 3000 : 1500
    const timer = setTimeout(() => setState({ status: "idle" }), delay)
    return () => clearTimeout(timer)
  }, [state.status])

  async function handleClick() {
    setState({ status: "loading" })
    try {
      const res = await fetch(`/api/sheets/invoice?customer=${encodeURIComponent(customer)}`, { cache: "no-store" })
      const data: InvoiceResult = await res.json()
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Failed")
      const invoiceEvent = data.events.find((e) => e.eventId === event)
      if (!invoiceEvent) throw new Error(`No invoice found for ${customer} · ${event}`)
      await copyToClipboard(invoiceEvent.message)
      setState({ status: "copied" })
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Failed" })
    }
  }

  const { status } = state
  const label =
    status === "loading" ? "…"
    : status === "copied" ? "✓"
    : status === "error" ? "!"
    : undefined

  return (
    <button
      onClick={handleClick}
      disabled={status === "loading"}
      title={status === "error" ? state.message : "Copy invoice message"}
      className={`p-1 transition-colors rounded disabled:opacity-50 ${
        status === "copied" ? "text-green-600"
        : status === "error" ? "text-red-500"
        : "text-gray-400 hover:text-brand"
      }`}
    >
      {label ? (
        <span className="text-xs font-medium w-3.5 inline-block text-center">{label}</span>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8" />
          <path d="M8 17h5" />
        </svg>
      )}
    </button>
  )
}
