"use client"

import { useEffect, useState } from "react"

/**
 * Her WhatsApp number, for a screen that has her handle and a message to send.
 *
 * The refund screens never had it, which is why their WhatsApp link carried no
 * number and always made you find her by hand. One small lookup, not the whole
 * invoice — this is needed to build a link, not to show anything.
 */
export function useCustomerWhatsApp(customer: string | null | undefined): string | null {
  const [whatsapp, setWhatsapp] = useState<string | null>(null)
  useEffect(() => {
    const who = customer?.trim()
    if (!who) { setWhatsapp(null); return }
    let live = true
    fetch(`/api/sheets/customer?id=${encodeURIComponent(who)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { whatsapp?: string | null } | null) => { if (live) setWhatsapp(d?.whatsapp ?? null) })
      // No number just means WhatsApp's own chat picker, so a failed lookup is
      // a smaller thing than the screen it would break.
      .catch(() => { if (live) setWhatsapp(null) })
    return () => { live = false }
  }, [customer])
  return whatsapp
}
