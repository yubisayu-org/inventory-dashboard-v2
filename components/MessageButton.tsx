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
    const glyph = toWhatsApp ? (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.44 1.32 4.94L2.05 22l5.29-1.38a9.9 9.9 0 0 0 4.7 1.2h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.85 9.85 0 0 0 12.04 2zm5.8 14.16c-.24.68-1.2 1.25-1.96 1.41-.52.11-1.2.2-3.5-.75-2.94-1.22-4.83-4.2-4.98-4.4-.15-.19-1.2-1.59-1.2-3.04 0-1.44.75-2.15 1.02-2.45.24-.26.55-.36.79-.36.2 0 .38.01.55.01.18.01.42-.07.65.5.24.6.82 2.06.89 2.21.07.15.12.33.02.53-.1.19-.15.31-.29.48-.15.17-.31.38-.44.51-.15.15-.3.31-.13.6.17.29.75 1.24 1.62 2.01 1.11.99 2.05 1.3 2.34 1.44.29.15.46.13.63-.08.17-.2.72-.84.92-1.13.19-.29.39-.24.65-.14.27.09 1.7.8 1.99.95.29.15.48.22.55.35.07.13.07.75-.17 1.43z" />
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
