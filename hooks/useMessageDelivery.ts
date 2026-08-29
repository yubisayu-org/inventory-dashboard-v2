"use client"

import { useEffect, useState } from "react"
import type { BusinessProfile } from "@/lib/business-profile"
import { DEFAULT_MESSAGE_DELIVERY, type MessageDelivery } from "@/lib/message-delivery"

/**
 * How the shop sends each kind of message, for the screens that send them.
 *
 * Returns the safe default until the answer arrives, so a message button never
 * renders as nothing and never renders as WhatsApp by accident on a slow
 * connection -- copying is the harmless guess.
 */
export function useMessageDelivery(): MessageDelivery {
  const [delivery, setDelivery] = useState<MessageDelivery>(DEFAULT_MESSAGE_DELIVERY)
  useEffect(() => {
    let live = true
    fetch("/api/sheets/business-profile", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { profile?: BusinessProfile }) => {
        if (live && d.profile?.messageDelivery) setDelivery(d.profile.messageDelivery)
      })
      // A settings read that fails must not take a message screen with it.
      .catch(() => {})
    return () => { live = false }
  }, [])
  return delivery
}
