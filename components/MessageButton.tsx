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
}) {
  const delivery = useMessageDelivery()
  const { copied, copy } = useCopyFeedback()
  const base = className
    ?? "shrink-0 px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand-dark transition-colors disabled:opacity-50"

  if (delivery[kind] === "whatsapp") {
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
