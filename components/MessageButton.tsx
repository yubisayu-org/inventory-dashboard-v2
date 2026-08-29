"use client"

import { useCopyFeedback } from "@/hooks/useCopyFeedback"
import { useMessageDelivery } from "@/hooks/useMessageDelivery"
import { waLink, type MessageKind } from "@/lib/message-delivery"

/**
 * One button for sending one message, doing whatever Settings says.
 *
 * Every message screen used to carry two: Copy, for pasting into a DM, and
 * WhatsApp, for opening her chat. Both were always there, so the same standing
 * decision -- which channel this shop uses for this kind of message -- got made
 * again dozens of times a week, and got made differently by whoever was tired.
 *
 * Settings → Communication answers it once per kind. This renders the answer.
 */
export function MessageButton({
  kind,
  message,
  whatsapp,
  disabled,
  className,
  copyLabel = "Copy",
  sendLabel = "Send on WhatsApp",
  variant = "text",
}: {
  kind: MessageKind
  message: string
  /** Her number, however it was typed. Missing means WhatsApp's own chat
   *  picker, which is better than refusing to send. */
  whatsapp?: string | null
  disabled?: boolean
  className?: string
  copyLabel?: string
  sendLabel?: string
  /**
   * "icon" draws the action instead of naming it -- a clipboard for copy, the
   * WhatsApp mark for send. Where the control sits in a row of small icons, a
   * word reading "Copy" while the setting says WhatsApp (or the other way
   * round) is worse than no word: the label and the behaviour are set in two
   * different places, and only one of them is on screen.
   */
  variant?: "text" | "icon"
}) {
  const delivery = useMessageDelivery()
  const { copied, copy } = useCopyFeedback()
  const base = className
    ?? "shrink-0 px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand-dark transition-colors disabled:opacity-50"
  const toWhatsApp = delivery[kind] === "whatsapp"

  if (variant === "icon") {
    const label = toWhatsApp ? sendLabel : copied ? "Copied" : copyLabel
    // Drawn in the same hand as the icons beside it: outlined, one stroke
    // weight, no fill. The brand's own mark is a solid glyph and sat in that
    // row looking like a sticker on a line drawing.
    const glyph = toWhatsApp ? (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    ) : copied ? (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    ) : (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    )
    const shell = className
      ?? "inline-flex items-center justify-center w-6 h-6 rounded border border-cream-border text-muted hover:bg-surface-sunken transition-colors shrink-0 disabled:opacity-50"

    return toWhatsApp ? (
      <a
        href={waLink(whatsapp, message)}
        target="_blank"
        rel="noopener noreferrer"
        title={label}
        aria-label={label}
        className={`${shell} ${disabled ? "pointer-events-none opacity-50" : ""}`}
        aria-disabled={disabled}
      >
        {glyph}
      </a>
    ) : (
      <button type="button" onClick={() => copy(message)} disabled={disabled}
        title={label} aria-label={label} className={shell}>
        {glyph}
      </button>
    )
  }

  if (toWhatsApp) {
    return (
      <a
        href={waLink(whatsapp, message)}
        target="_blank"
        rel="noopener noreferrer"
        className={`${base} inline-flex items-center justify-center ${disabled ? "pointer-events-none opacity-50" : ""}`}
        aria-disabled={disabled}
      >
        {sendLabel}
      </a>
    )
  }

  return (
    <button type="button" onClick={() => copy(message)} disabled={disabled} className={base}>
      {copied ? "Copied!" : copyLabel}
    </button>
  )
}
