"use client"

import { useEffect, useState } from "react"
import type { InvoiceEvent } from "@/lib/db"
import { useCopyFeedback } from "@/hooks/useCopyFeedback"

export function InvoiceMessageActions({ event }: { event: InvoiceEvent }) {
  const [open, setOpen] = useState(false)
  const { copied, copy } = useCopyFeedback()
  const { message } = event

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
      >
        View message
      </button>
      <button
        type="button"
        onClick={() => copy(message)}
        className="shrink-0 px-3 py-1.5 rounded-lg border border-brand text-brand text-xs font-medium hover:bg-brand hover:text-white transition-colors"
      >
        {copied ? "Copied!" : "Copy message"}
      </button>
      {open && (
        <InvoiceMessageModal
          message={message}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function InvoiceMessageModal({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}) {
  const { copied, copy } = useCopyFeedback()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-3 border-b border-cream-border flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">Invoice message</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-foreground transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <pre className="px-5 py-4 overflow-auto text-sm text-foreground whitespace-pre-wrap font-sans flex-1">
          {message}
        </pre>
        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => copy(message)}
            className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
          >
            {copied ? "Copied!" : "Copy message"}
          </button>
        </div>
      </div>
    </div>
  )
}
