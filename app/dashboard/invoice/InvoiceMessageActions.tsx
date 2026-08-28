"use client"

import { useEffect, useState } from "react"
import type { InvoiceEvent } from "@/lib/db"
import { MessageButton } from "@/components/MessageButton"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import {
  NOTICE_TEMPLATES,
  NOTICE_TOKENS,
  OFFERED_REFUND_CAUSES,
  causeLineFor,
  applyNoticeOverrides,
  fillNotice,
  unknownTokens,
  type NoticeKey,
  type NoticeOverride,
  type NoticeTemplate,
  type NoticeTokens,
  type RefundCause,
} from "@/lib/notice-templates"

export function InvoiceMessageActions({
  event, whatsapp, customer,
}: { event: InvoiceEvent; whatsapp?: string | null; customer?: string }) {
  const [open, setOpen] = useState(false)
  const [telling, setTelling] = useState(false)
  const { message } = event

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:border-brand hover:text-brand transition-colors"
      >
        View message
      </button>
      {/* Always offered, whatever the balance: an invoice that is settled can
          still need a word about a delay or a refund, and a control that
          vanishes reads as a broken deploy rather than a rule. */}
      {customer && (
        <button
          type="button"
          onClick={() => setTelling(true)}
          title="Send a notice on the catalogue"
          className="shrink-0 px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
        >
          Send notice
        </button>
      )}
      {telling && customer && (
        <TellHerModal event={event} customer={customer} onClose={() => setTelling(false)} />
      )}
      {open && (
        <InvoiceMessageModal
          message={message}
          whatsapp={whatsapp}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function InvoiceMessageModal({
  message,
  whatsapp,
  onClose,
}: {
  message: string
  whatsapp?: string | null
  onClose: () => void
}) {
  useModalDismiss(onClose)

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
            className="text-faint hover:text-foreground transition-colors"
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
          {/* One button, doing whichever thing Settings → Communication says
              this shop does with an invoice. */}
          <MessageButton
            kind="invoice"
            message={message}
            whatsapp={whatsapp}
            className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand-dark transition-colors"
          />
        </div>
      </div>
    </div>
  )
}

// ─── Tell her ────────────────────────────────────────────────────────────────
// A reason, the wording filled in from this trip's own numbers, and one press.
// Editable before it goes, because house style and this particular customer are
// not always the same sentence — but the edits are for this message only.

function idr(n: number): string {
  return `Rp ${Math.round(n).toLocaleString("id-ID")}`
}

function TellHerModal({
  event, customer, onClose,
}: { event: InvoiceEvent; customer: string; onClose: () => void }) {
  // The house wording, plus whatever the owner rewrote in Settings. It starts
  // as the code defaults and is replaced once the fetch lands, so the modal is
  // usable the instant it opens and never blocks on a settings read. A reason
  // already picked keeps its identity across the swap — only its wording
  // changes, and only if the field is still untouched.
  const [wordings, setWordings] = useState<NoticeTemplate[]>(NOTICE_TEMPLATES)
  const [reason, setReason] = useState<NoticeTemplate>(NOTICE_TEMPLATES[0])
  const [cause, setCause] = useState<RefundCause>(OFFERED_REFUND_CAUSES[0])
  const [title, setTitle] = useState(NOTICE_TEMPLATES[0].title)
  const [body, setBody] = useState(NOTICE_TEMPLATES[0].body)
  // How many units of each line the refund is about. Keyed by orderId.
  const [missing, setMissing] = useState<Record<number, number>>({})
  const [manualAmount, setManualAmount] = useState(0)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState("")
  useModalDismiss(onClose)
  useEffect(() => {
    let live = true
    fetch("/api/sheets/notice-templates", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { overrides?: Partial<Record<NoticeKey, NoticeOverride>> }) => {
        if (!live) return
        const next = applyNoticeOverrides(data.overrides)
        setWordings(next)
        // Only adopt the edited wording where nothing has been typed over it
        // yet — an owner mid-sentence must not have it swapped underneath.
        setReason((current) => {
          const match = next.find((t) => t.key === current.key)
          if (!match) return current
          setTitle((t) => (t === current.title ? match.title : t))
          setBody((b) => (b === current.body ? match.body : b))
          return match
        })
      })
      // A settings read that fails leaves the house wording in place, which is
      // what this modal has always sent.
      .catch(() => {})
    return () => { live = false }
  }, [])

  const isRefund = Boolean(reason.isRefund)
  const needsItems = isRefund && Boolean(cause.needsItems)
  const needsAmount = isRefund && !cause.needsItems && !cause.fixed
  const overpaid = Math.max(0, -event.invoice.sisaPelunasan)

  // What the Arrival List recorded as arriving instead, per item she ordered.
  // Fetched only when the wording would use it: every other cause is unchanged
  // by it, and most refunds are not wrong deliveries.
  const [received, setReceived] = useState<Record<string, string>>({})
  const wantsReceived = cause.needsReceived === true
  useEffect(() => {
    if (!wantsReceived) return
    let live = true
    fetch(`/api/sheets/wrong-deliveries?event=${encodeURIComponent(event.eventId)}`)
      .then((r) => r.json())
      .then((d: { received?: Record<string, string> }) => { if (live) setReceived(d.received ?? {}) })
      // Silent: without it the wording simply drops to the sentence that does
      // not name the substitute, which is what it always used to send.
      .catch(() => {})
    return () => { live = false }
  }, [wantsReceived, event.eventId])

  const chosen = event.orders.filter((o) => (missing[o.orderId] ?? 0) > 0)
  const itemsList = chosen
    .map((o) => `${o.productName} × ${missing[o.orderId]}`)
    .join(", ")
  const itemsTotal = chosen.reduce((n, o) => n + o.rawUnitPrice * (missing[o.orderId] ?? 0), 0)
  // Named once each: two lines of the same wrong delivery is still one thing
  // that turned up.
  const receivedList = [...new Set(
    chosen.map((o) => received[o.productName]).filter((n): n is string => Boolean(n)),
  )].join(", ")

  // Where the figure comes from depends on the cause: ticked lines, the
  // invoice's own overpayment, or a number typed. Never all three.
  const refundAmount = needsItems ? itemsTotal : cause.fixed ? overpaid : manualAmount

  const values: NoticeTokens = {
    "{customer}": customer,
    "{event}": event.eventId,
    "{total}": idr(event.invoice.total),
    "{outstanding}": idr(Math.max(0, event.invoice.sisaPelunasan)),
    "{refundAmount}": idr(refundAmount),
    "{itemsList}": itemsList || "the item",
    "{receivedItem}": receivedList,
    // Where the Arrival List recorded a substitute, say what it was. Where it
    // did not — a refund raised for something never marked — causeLineFor drops
    // to the wording that does not need it, rather than sending her a sentence
    // with "{receivedItem}" printed in the middle.
    "{cause}": fillNotice(causeLineFor(cause, { items: itemsList, receivedItem: receivedList }), {
      "{event}": event.eventId,
      "{itemsList}": itemsList || "the item",
      "{receivedItem}": receivedList,
    }),
  }

  const bad = unknownTokens(`${title} ${body}`)
  const emptyText = !title.trim() || !body.trim()
  const noMoney = isRefund && refundAmount <= 0
  const canSend = !emptyText && bad.length === 0 && !noMoney && !sending

  function loadTemplate(next: NoticeTemplate) {
    setReason(next)
    setTitle(next.title)
    setBody(next.body)
    setError("")
    setSent(false)
  }

  function step(orderId: number, by: number, max: number) {
    setMissing((prev) => ({
      ...prev,
      [orderId]: Math.max(0, Math.min(max, (prev[orderId] ?? 0) + by)),
    }))
  }

  async function send() {
    setSending(true)
    setError("")
    try {
      const res = await fetch("/api/sheets/invoice/notice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: event.eventId,
          customer,
          title: fillNotice(title, values),
          body: fillNotice(body, values),
          refund: isRefund
            ? {
                cause: cause.key,
                amount: refundAmount,
                // One line, one refund row. Several lines share a row and name
                // them in the note, which is what the staff screen already reads.
                orderId: chosen.length === 1 ? chosen[0].orderId : null,
                affectedUnits: chosen.reduce((n, o) => n + (missing[o.orderId] ?? 0), 0),
                items: itemsList,
              }
            : null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to send")
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send")
    } finally {
      setSending(false)
    }
  }

  const LABEL = "block text-[11px] font-semibold uppercase tracking-wide text-muted mb-1"
  const INPUT =
    "w-full px-3 py-2 rounded-lg border border-cream-border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white border border-cream-border">
        <div className="px-5 py-3 border-b border-cream-border flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold">What to tell them</h3>
            <p className="text-xs text-muted">
              {customer} · {event.eventId} · goes to their inbox on the catalogue
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-faint hover:text-brand text-xl leading-none">
            ×
          </button>
        </div>

        <div className="p-5 grid gap-5 md:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="grid gap-1.5 content-start">
            {wordings.map((t) => (
              <label
                key={t.key}
                className={`flex items-start gap-2 text-sm px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                  reason.key === t.key ? "border-brand bg-brand-light" : "border-cream-border hover:border-brand"
                }`}
              >
                <input
                  type="radio"
                  name="notice-reason"
                  checked={reason.key === t.key}
                  onChange={() => loadTemplate(t)}
                  className="mt-1 accent-brand"
                />
                <span>
                  {t.label}
                  <span className="block text-[10px] text-faint font-mono">{t.key}</span>
                </span>
              </label>
            ))}
          </div>

          <div>
            {isRefund && (
              <>
                <div className="mb-3">
                  <label className={LABEL} htmlFor="notice-cause">Why the money is coming back</label>
                  <select
                    id="notice-cause"
                    value={cause.key}
                    onChange={(e) => setCause(OFFERED_REFUND_CAUSES.find((c) => c.key === e.target.value) ?? OFFERED_REFUND_CAUSES[0])}
                    className={INPUT}
                  >
                    {OFFERED_REFUND_CAUSES.map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-faint mt-1">
                    Saved on the refund as <span className="font-mono">reason: &apos;{cause.key}&apos;</span>, so
                    their card says the same thing weeks later.
                  </p>
                </div>

                {needsItems && (
                  <div className="mb-3 border border-cream-border rounded-lg overflow-hidden">
                    <div className="px-3 py-1.5 bg-cream text-[11px] font-semibold uppercase tracking-wide text-brand flex justify-between">
                      <span>Which lines</span>
                      <span>{event.orders.length} on this trip</span>
                    </div>
                    {event.orders.map((o) => {
                      const qty = missing[o.orderId] ?? 0
                      return (
                        <div
                          key={o.orderId}
                          className={`flex items-center gap-2 px-3 py-2 text-sm border-t border-cream-border ${qty ? "bg-brand-light" : ""}`}
                        >
                          <span className="flex-1 min-w-0">
                            {o.productName}
                            <span className="block text-[11px] text-faint">
                              {idr(o.rawUnitPrice)} each · {o.unit} ordered
                            </span>
                          </span>
                          <span className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => step(o.orderId, -1, o.unit)}
                              disabled={qty === 0}
                              className="w-6 h-6 rounded border border-cream-border text-brand font-bold disabled:opacity-30"
                            >
                              −
                            </button>
                            <span className="w-12 text-center tabular-nums font-semibold">{qty} / {o.unit}</span>
                            <button
                              type="button"
                              onClick={() => step(o.orderId, 1, o.unit)}
                              disabled={qty >= o.unit}
                              className="w-6 h-6 rounded border border-cream-border text-brand font-bold disabled:opacity-30"
                            >
                              +
                            </button>
                          </span>
                        </div>
                      )
                    })}
                    <div className="flex justify-between px-3 py-2 bg-surface-muted border-t border-cream-border text-sm font-semibold">
                      <span>{itemsList || "Nothing chosen yet"}</span>
                      <span className="tabular-nums text-green-700">{idr(itemsTotal)}</span>
                    </div>
                  </div>
                )}

                {needsAmount && (
                  <div className="mb-3">
                    <label className={LABEL} htmlFor="notice-amount">How much</label>
                    <input
                      id="notice-amount"
                      inputMode="numeric"
                      value={manualAmount ? manualAmount.toLocaleString("id-ID") : ""}
                      onChange={(e) => setManualAmount(Number(e.target.value.replace(/\D/g, "")) || 0)}
                      placeholder="0"
                      className={`${INPUT} tabular-nums font-semibold`}
                    />
                  </div>
                )}

                {cause.fixed && (
                  <div className="mb-3 flex justify-between px-3 py-2 rounded-lg border border-cream-border text-sm font-semibold">
                    <span>Overpaid on this invoice</span>
                    <span className="tabular-nums text-green-700">{idr(overpaid)}</span>
                  </div>
                )}
              </>
            )}

            <div className="mb-3">
              <label className={LABEL} htmlFor="notice-title">Title</label>
              <input id="notice-title" value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} />
            </div>

            <div>
              <label className={LABEL} htmlFor="notice-body">Message</label>
              <textarea
                id="notice-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                className={`${INPUT} leading-relaxed`}
              />
              <div className="flex flex-wrap gap-1 mt-1.5">
                {NOTICE_TOKENS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setBody((b) => `${b}${t}`)}
                    className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded border border-cream-border bg-surface-sunken hover:border-brand hover:text-brand"
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {bad.length > 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 mt-2">
                {bad.join(", ")} is not a placeholder we know — they would read it exactly as written.
              </p>
            )}
            {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
          </div>
        </div>

        <div className="px-5 py-3 bg-surface-muted border-t border-cream-border flex items-center justify-between gap-3 flex-wrap">
          <span className="text-xs text-muted">
            {sent
              ? isRefund
                ? `Sent — and a refund of ${idr(refundAmount)} created with reason '${cause.key}'.`
                : "Sent. They have it now."
              : emptyText
                ? "A title and a message are both required."
                : noMoney
                  ? needsItems
                    ? "Choose which lines it is about."
                    : "Fill in how much is coming back."
                  : `They read: “${fillNotice(title, values)}”`}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => loadTemplate(reason)}
              className="px-4 py-2 rounded-lg border border-cream-border text-muted-strong text-sm hover:border-brand hover:text-brand transition-colors"
            >
              Reset to template
            </button>
            <button
              type="button"
              onClick={sent ? onClose : send}
              disabled={!sent && !canSend}
              className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {sent ? "Close" : sending ? "Sending…" : "Send to inbox"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
