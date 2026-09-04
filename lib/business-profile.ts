// Shared business identity fields, edited once from /dashboard/settings and
// reused wherever a message needs them (today: the invoice's bank details;
// ownerName/storeName/phoneNumber aren't wired into any message yet, they're
// just stored for later).
//
// The DP threshold used to live here (migration 043) but moved to
// ProductDefaults (migration 057) — it's a pricing-adjacent setting, not
// business identity, and the Settings page groups it with the rest of the
// Pricing tab.

import { DEFAULT_MESSAGE_DELIVERY, type MessageDelivery } from "./message-delivery"

export interface BusinessProfile {
  bankAccountHolder: string
  /** One "Bank Name 123456789" per line. */
  bankAccountLines: string
  ownerName: string
  storeName: string
  phoneNumber: string
  /** Public order-status site, e.g. "Cek rekapan mandiri {publicSiteUrl}" in
   *  the invoice message and "Cek resi {publicSiteUrl}" in the shipment one. */
  publicSiteUrl: string
  /** How each kind of message reaches her — copy, or open her WhatsApp. */
  messageDelivery: MessageDelivery
  /** QRIS as a second way to pay. See lib/db/catalogue-payments.ts for what
   *  each ceiling actually guards; 0 means that ceiling is off. */
  qris: QrisSettings
}

export interface QrisSettings {
  /** Offered to customers at all. False until a QR has been uploaded. */
  enabled: boolean
  /** Public Storage URL of the static QR. */
  imageUrl: string
  /** The name her wallet app will show — she checks it before confirming,
   *  which is the only real defence against a swapped QR. */
  merchantName: string
  /** Most one scan may be. Inclusive: 100000 allows exactly 100.000. */
  maxPerPayment: number
  /** Most one order may put through QRIS, across every scan on it. */
  maxPerOrder: number
  /** Most the shop may take through QRIS in a rolling twelve months,
   *  counting what staff record by hand as well as what customers claim. */
  maxPerYear: number
}

export const DEFAULT_QRIS: QrisSettings = {
  enabled: false,
  imageUrl: "",
  merchantName: "",
  maxPerPayment: 0,
  maxPerOrder: 0,
  maxPerYear: 0,
}

export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
  bankAccountHolder: "Shinta Michiko",
  bankAccountLines: "Bank Jago (Artos) 103382719370\nBank Central Asia 4419051991",
  ownerName: "",
  storeName: "Yubisayu",
  phoneNumber: "",
  publicSiteUrl: "https://yubisayu-invoice.netlify.app/",
  messageDelivery: DEFAULT_MESSAGE_DELIVERY,
  qris: DEFAULT_QRIS,
}

/**
 * Whatever arrives from the Settings form, reduced to something safe to store.
 *
 * The image URL is checked against our own Storage host rather than merely
 * being a URL. The account is the owner's, so this is not the main defence —
 * but the whole risk with a static QR is a *swapped* image, and an URL field
 * that will accept any host is precisely the way one gets swapped. A QR can
 * only be a file we uploaded ourselves.
 */
export function normalizeQris(input: unknown): QrisSettings {
  const raw = (input ?? {}) as Partial<Record<keyof QrisSettings, unknown>>

  const url = String(raw.imageUrl ?? "").trim()
  const base = process.env.SUPABASE_URL ?? ""
  const allowed = base ? `${base.replace(/\/$/, "")}/storage/v1/object/public/` : ""
  const imageUrl = url && allowed && url.startsWith(allowed) ? url : ""

  // A ceiling is a whole number of rupiah, never negative. 0 switches it off,
  // which is what an emptied field means.
  const ceiling = (value: unknown): number => {
    const n = Math.floor(Number(value))
    if (!Number.isFinite(n) || n <= 0) return 0
    return Math.min(n, 1_000_000_000_000)
  }

  return {
    // Nothing to scan means nothing to offer, whatever the switch says.
    enabled: Boolean(raw.enabled) && Boolean(imageUrl),
    imageUrl,
    merchantName: String(raw.merchantName ?? "").trim().slice(0, 120),
    maxPerPayment: ceiling(raw.maxPerPayment),
    maxPerOrder: ceiling(raw.maxPerOrder),
    maxPerYear: ceiling(raw.maxPerYear),
  }
}
