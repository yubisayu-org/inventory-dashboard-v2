"use client"

import { useEffect, useState } from "react"
import {
  TEMPLATE_KEYS,
  REQUIRED_TOKENS,
  OPTIONAL_TOKENS,
  DEFAULT_TEMPLATES,
  fillTemplate,
  findMissingTokens,
  type TemplateKey,
} from "@/lib/message-templates"
import {
  NOTICE_TEMPLATES,
  NOTICE_TOKENS,
  NOTICE_TOKENS_FOR,
  fillNotice,
  unknownTokens,
  type NoticeKey,
  type NoticeOverride,
  type NoticeTemplate,
  type NoticeTokens,
} from "@/lib/notice-templates"
import { DEFAULT_BUSINESS_PROFILE, type BusinessProfile, type QrisSettings } from "@/lib/business-profile"
import { DEFAULT_PRODUCT_DEFAULTS, type ProductDefaults } from "@/lib/product-defaults"
import {
  PRICING_METHODS, PRICING_METHOD_LABEL, toPricingMethod,
  calcRupiahFeePrice, flatFeeAmount, flatFeeFloorApplies, ceilTo,
} from "@/lib/pricing"
import type { CountryRow } from "@/lib/db"
import KursTiersSection from "./KursTiersSection"
import TierFeeBracketsSection from "./TierFeeBracketsSection"
import WhatsAppSection from "./WhatsAppSection"
import {
  MESSAGE_KINDS, MESSAGE_KIND_LABELS, MESSAGE_KIND_HINTS, DELIVERY_LABELS, type DeliveryMode,
} from "@/lib/message-delivery"
import DispatchRoutesSection from "./DispatchRoutesSection"
import WarehouseOriginSection from "./WarehouseOriginSection"
import MoneyInput from "@/components/MoneyInput"
import InfoTooltip from "@/components/InfoTooltip"

const fmt = (n: number) => n.toLocaleString("id-ID")

const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  invoice: "Invoice message",
  invoice_dp: "Invoice message — DP reminder",
  shipment: "Shipment confirmation",
  refund_specific: "Refund message — with the item list",
  refund_generic: "Refund message — no item list",
}

// Sample data so the preview pane renders something readable while editing —
// values only, never sent anywhere.
const SAMPLE_VARS: Record<TemplateKey, Record<string, string>> = {
  invoice: {
    eventId: "EVT1",
    handle: "@customer",
    produkLines: "Lip Balm x 2 x Rp 150,000",
    subtotalBarang: "300,000",
    weightKg: "2",
    perKgRate: "50,000",
    biayaLainnyaBlock: "\nBiaya Lainnya: Rp 10,000",
    sisaPelunasan: "250,000",
    bankAccountHolder: "Business Owner",
    bankAccountLines: "Bank Example 123456789",
    publicSiteUrl: "https://example.com/",
  },
  invoice_dp: {
    eventId: "EVT1",
    handle: "@customer",
    produkLines: "Lip Balm x 2 x Rp 150,000",
    subtotalBarang: "300,000",
    weightKg: "2",
    perKgRate: "50,000",
    biayaLainnyaBlock: "\nBiaya Lainnya: Rp 10,000",
    dpPercent: "30",
    dpAmount: "90,000",
    dpShortfall: "40,000",
    sisaPelunasan: "300,000",
    bankAccountHolder: "Business Owner",
    bankAccountLines: "Bank Example 123456789",
    publicSiteUrl: "https://example.com/",
  },
  shipment: {
    event: "EVT1",
    handle: "@customer",
    dataDiri: "Jane Doe\n0812xxxxxxx\nJl. Contoh No. 1, Jakarta",
    items: "Lip Balm x 2",
    publicSiteUrl: "https://example.com/",
  },
  refund_specific: {
    customer: "@customer",
    event: "EVT1",
    itemsList: "- Lip Balm",
    refundAmount: "Rp 150,000",
  },
  refund_generic: {
    customer: "@customer",
    event: "EVT1",
    refundAmount: "Rp 150,000",
  },
}

const textareaCls = "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white font-mono focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors min-h-[240px] resize-y"

type Tab = "business" | "product-defaults" | "messages" | "whatsapp"

const TABS: { key: Tab; label: string }[] = [
  { key: "business", label: "Profile" },
  { key: "product-defaults", label: "Pricing" },
  { key: "messages", label: "Templates" },
  { key: "whatsapp", label: "WhatsApp" },
]

export default function SettingsClient() {
  const [templates, setTemplates] = useState<Record<TemplateKey, string> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>("business")

  useEffect(() => {
    fetch("/api/sheets/message-templates", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { templates?: Record<TemplateKey, string>; error?: string }) => {
        if (data.error) setLoadError(data.error)
        else if (data.templates) setTemplates(data.templates)
      })
      .catch(() => setLoadError("Failed to load templates"))
  }, [])

  if (loadError) return <p className="text-sm text-red-600">{loadError}</p>
  if (!templates) return <p className="text-sm text-muted">Loading…</p>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 w-full rounded-xl border border-cream-border bg-white p-1 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`flex-1 shrink-0 flex items-center justify-center gap-1 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              tab === t.key
                ? "bg-brand text-white"
                : "text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Every panel stays mounted (each fetches its own data once) — only
          hidden ones are visually hidden, so switching tabs never refetches. */}
      <div className={`flex flex-col gap-6 ${tab === "business" ? "" : "hidden"}`}>
        <BusinessProfileSection />
        <DispatchRoutesSection />
        <WarehouseOriginSection />
      </div>
      {/* Every card here is pricing config, so they share one tab. General holds what is
          common to more than one method; the rest are per method, in PRICING_METHODS order.

          ProductDefaultsSection renders THREE of them — General, Profit Margin and
          Markup Flat — because all of those fields live in one product_defaults row behind
          one Save. Splitting the component would mean three components racing to write the
          same record. */}
      <div className={`flex flex-col gap-6 ${tab === "product-defaults" ? "" : "hidden"}`}>
        <ProductDefaultsSection />
        <TierFeeBracketsSection />
        <KursTiersSection />
      </div>
      <div className={`flex flex-col gap-6 ${tab === "messages" ? "" : "hidden"}`}>
        {TEMPLATE_KEYS.map((key) => (
          <TemplateSection key={key} templateKey={key} initialBody={templates[key]} />
        ))}
        {/* Its own box, last: everything above is copied by hand into a chat,
            this is sent from the invoice screen into her catalogue inbox. */}
        <InboxNoticesSection />
      </div>
      <div className={tab === "whatsapp" ? "" : "hidden"}>
        <WhatsAppSection />
      </div>
    </div>
  )
}

const fieldInputCls = "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

function BusinessProfileSection() {
  const [profile, setProfile] = useState<BusinessProfile | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    fetch("/api/sheets/business-profile", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { profile?: BusinessProfile; error?: string }) => {
        if (data.error) setLoadError(data.error)
        else if (data.profile) setProfile(data.profile)
      })
      .catch(() => setLoadError("Failed to load business profile"))
  }, [])

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(t)
  }, [saved])

  async function handleSave() {
    if (!profile) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/business-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to save")
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    setProfile(DEFAULT_BUSINESS_PROFILE)
  }

  function field(key: keyof BusinessProfile, value: string) {
    setProfile((p) => (p ? { ...p, [key]: value } : p))
  }

  function qrisField<K extends keyof QrisSettings>(key: K, value: QrisSettings[K]) {
    setProfile((p) => (p ? { ...p, qris: { ...p.qris, [key]: value } } : p))
  }

  async function handleQrisUpload(file: File) {
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await fetch("/api/sheets/qris-image", { method: "POST", body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Upload failed")
      qrisField("imageUrl", data.url as string)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-foreground">Business profile</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-green-600">Saved</span>}
          <button
            type="button"
            onClick={handleReset}
            title="Reset to default"
            aria-label="Reset to default"
            className="inline-flex items-center justify-center h-[30px] w-[30px] rounded-lg border border-cream-border text-muted hover:border-brand hover:text-brand transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !profile}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-light transition-colors disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {loadError && <p className="text-xs text-red-600">{loadError}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!profile && !loadError && <p className="text-xs text-muted">Loading…</p>}

      {profile && (
        <div className="grid md:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Bank account holder</span>
            <span className="text-[10px] text-faint">Used in the invoice message.</span>
            <input
              value={profile.bankAccountHolder}
              onChange={(e) => field("bankAccountHolder", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Bank accounts</span>
            <span className="text-[10px] text-faint">One "Bank Name 123456789" per line. Used in the invoice message.</span>
            <textarea
              value={profile.bankAccountLines}
              onChange={(e) => field("bankAccountLines", e.target.value)}
              className={`${fieldInputCls} font-mono min-h-[70px] resize-y`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Public site URL</span>
            <span className="text-[10px] text-faint">Used in the invoice and shipment messages.</span>
            <input
              value={profile.publicSiteUrl}
              onChange={(e) => field("publicSiteUrl", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Owner name</span>
            <span className="text-[10px] text-faint">Not used in any message yet.</span>
            <input
              value={profile.ownerName}
              onChange={(e) => field("ownerName", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Store name</span>
            <span className="text-[10px] text-faint">Not used in any message yet.</span>
            <input
              value={profile.storeName}
              onChange={(e) => field("storeName", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Phone number</span>
            <span className="text-[10px] text-faint">Not used in any message yet.</span>
            <input
              value={profile.phoneNumber}
              onChange={(e) => field("phoneNumber", e.target.value)}
              className={fieldInputCls}
            />
          </label>
        </div>
      )}

      {/* Communication — which channel each kind of message goes out on.
          Inside the profile card because it is the same row in the same table,
          saved by the same button: a second Save beside it is a second thing to
          forget to press. */}
      {profile && (
        <div className="flex flex-col gap-2 pt-3 border-t border-cream-border">
          <div>
            <h3 className="text-xs font-semibold text-foreground">Communication</h3>
            <p className="text-[10px] text-faint">
              Each message screen shows one button, and this is what it does. Copy puts the text on
              the clipboard for a DM; WhatsApp opens her chat with it already written.{" "}
              {/* The Save is at the top of this card, far enough up to be missed
                  from down here -- and a dropdown that looks committed the
                  moment it is changed is the kind of setting that quietly does
                  not apply. */}
              <span className="text-muted">Press Save at the top of this card to keep the change.</span>
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-3">
            {MESSAGE_KINDS.map((kind) => (
              <label key={kind} className="flex flex-col gap-1">
                <span className="text-xs text-muted">{MESSAGE_KIND_LABELS[kind]}</span>
                <span className="text-[10px] text-faint">{MESSAGE_KIND_HINTS[kind]}</span>
                <select
                  value={profile.messageDelivery[kind]}
                  onChange={(e) => setProfile((prev) => prev && ({
                    ...prev,
                    messageDelivery: { ...prev.messageDelivery, [kind]: e.target.value as DeliveryMode },
                  }))}
                  className={fieldInputCls}
                >
                  {(["copy", "whatsapp"] as DeliveryMode[]).map((mode) => (
                    <option key={mode} value={mode}>{DELIVERY_LABELS[mode]}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* QRIS — the second way a customer may pay, on the catalogue's Add
          payment sheet. Same card and same Save as the bank details above,
          because it is the same row of the same table and a second Save is a
          second thing to forget. The image is the exception: it uploads the
          moment it is chosen, since a file cannot sit in a JSON PATCH. */}
      {profile && (
        <div className="flex flex-col gap-2 pt-3 border-t border-cream-border">
          <div>
            <h3 className="text-xs font-semibold text-foreground">QRIS</h3>
            <p className="text-[10px] text-faint">
              Offered beside the bank transfer when every ceiling below allows it. An empty
              ceiling means no limit.{" "}
              <span className="text-muted">Press Save at the top of this card to keep the change.</span>
            </p>
          </div>

          <label className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={profile.qris.enabled}
              disabled={!profile.qris.imageUrl}
              onChange={(e) => qrisField("enabled", e.target.checked)}
              className="accent-brand"
            />
            Offer QRIS to customers
            {!profile.qris.imageUrl && (
              <span className="text-[10px] text-faint">— upload the QR first</span>
            )}
          </label>

          <div className="flex items-start gap-3 border border-dashed border-cream-border rounded-lg p-3">
            {profile.qris.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profile.qris.imageUrl}
                alt="The shop's QRIS code"
                className="w-24 h-24 object-contain bg-white rounded border border-cream-border"
              />
            ) : (
              <div className="w-24 h-24 grid place-items-center rounded border border-cream-border text-[10px] text-faint text-center px-2">
                No QR yet
              </div>
            )}
            <div className="flex flex-col gap-1 text-[10px] text-faint">
              <span className="text-xs text-muted">The static QR from your merchant account.</span>
              <span>
                Customers scan this to pay. Replace it whenever your acquirer reissues one — and
                check the picture above is yours before saving.
              </span>
              <label className="inline-flex w-fit items-center text-xs font-medium px-3 py-1.5 mt-1 rounded-lg border border-cream-border text-brand hover:border-brand transition-colors cursor-pointer">
                {uploading ? "Uploading…" : profile.qris.imageUrl ? "Replace image" : "Upload image"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    // Cleared so choosing the same file twice still fires a change.
                    e.target.value = ""
                    if (file) void handleQrisUpload(file)
                  }}
                />
              </label>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Merchant name on the QR</span>
              <span className="text-[10px] text-faint">
                Shown to her so she can check it before confirming — the one thing that catches a
                swapped QR.
              </span>
              <input
                value={profile.qris.merchantName}
                onChange={(e) => qrisField("merchantName", e.target.value)}
                className={fieldInputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Most per payment</span>
              <span className="text-[10px] text-faint">One scan may be exactly this much, not more.</span>
              <input
                value={formatCeiling(profile.qris.maxPerPayment)}
                inputMode="numeric"
                onChange={(e) => qrisField("maxPerPayment", readCeiling(e.target.value))}
                className={fieldInputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Most per order</span>
              <span className="text-[10px] text-faint">
                Every QRIS scan on one order, added up. Without this she can split an order into
                small scans and put all of it through QRIS.
              </span>
              <input
                value={formatCeiling(profile.qris.maxPerOrder)}
                inputMode="numeric"
                onChange={(e) => qrisField("maxPerOrder", readCeiling(e.target.value))}
                className={fieldInputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Most per year</span>
              <span className="text-[10px] text-faint">
                A rolling twelve months, counting payments staff record by hand too. QRIS stops
                being offered once it is reached.
              </span>
              <input
                value={formatCeiling(profile.qris.maxPerYear)}
                inputMode="numeric"
                onChange={(e) => qrisField("maxPerYear", readCeiling(e.target.value))}
                className={fieldInputCls}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  )
}

/** A ceiling as she reads it, with the shop's thousands dots. 0 is the off
 *  position, and an off ceiling shows as an empty field rather than a zero
 *  she would have to interpret. */
function formatCeiling(n: number): string {
  return n > 0 ? n.toLocaleString("id-ID") : ""
}

/** …and back again. Anything that is not a digit is not part of a number. */
function readCeiling(value: string): number {
  const digits = value.replace(/\D/g, "")
  return digits ? Number(digits) : 0
}

/**
 * Fetches the one product_defaults row and hands it to four independently-saved
 * cards (General/Profit Margin/Custom Request Estimate/Markup Flat — Kurs Tiers
 * rounding is a fifth, elsewhere). Each card PATCHes only the fields it owns
 * (see the route), so saving one can no longer clobber another's unsaved edits
 * or a value changed from a different card since this page loaded.
 */
function ProductDefaultsSection() {
  const [defaults, setDefaults] = useState<ProductDefaults | null>(null)
  const [countries, setCountries] = useState<CountryRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  // Only for the Default country select's options. A failure here is not surfaced: the rest of
  // the card is still usable, and the select falls back to showing IDR plus whatever id is
  // already saved. /api/sheets/countries returns { rows }, not { countries }.
  useEffect(() => {
    fetch("/api/sheets/countries", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { rows?: CountryRow[] }) => setCountries(data.rows ?? []))
      .catch(() => setCountries([]))
  }, [])

  useEffect(() => {
    fetch("/api/sheets/product-defaults", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { defaults?: ProductDefaults; error?: string }) => {
        if (data.error) setLoadError(data.error)
        else if (data.defaults) setDefaults(data.defaults)
      })
      .catch(() => setLoadError("Failed to load product defaults"))
  }, [])

  return (
    <>
      <GeneralCard defaults={defaults} setDefaults={setDefaults} loadError={loadError} countries={countries} />
      <ProfitMarginCard defaults={defaults} setDefaults={setDefaults} loadError={loadError} />
      <CustomRequestEstimateCard defaults={defaults} setDefaults={setDefaults} loadError={loadError} />
      <MarkupFlatCard defaults={defaults} setDefaults={setDefaults} loadError={loadError} />
    </>
  )
}

type ProductDefaultsCardProps = {
  defaults: ProductDefaults | null
  setDefaults: React.Dispatch<React.SetStateAction<ProductDefaults | null>>
  loadError: string | null
}

/** Saved/saving/error state, and the PATCH, scoped to exactly the fields in `keys` — the
 *  shape every card below shares, so a save can only ever touch its own card's columns. */
function useCardSave(
  defaults: ProductDefaults | null,
  setDefaults: React.Dispatch<React.SetStateAction<ProductDefaults | null>>,
  keys: readonly (keyof ProductDefaults)[],
) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(t)
  }, [saved])

  async function handleSave() {
    if (!defaults) return
    setSaving(true)
    setError(null)
    try {
      const body = Object.fromEntries(keys.map((k) => [k, defaults[k]]))
      const res = await fetch("/api/sheets/product-defaults", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to save")
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  // Only this card's fields reset — the others keep whatever is on screen, saved or not.
  function handleReset() {
    setDefaults((d) => (d ? { ...d, ...Object.fromEntries(keys.map((k) => [k, DEFAULT_PRODUCT_DEFAULTS[k]])) } : d))
  }

  return { saving, error, saved, handleSave, handleReset }
}

function CardHeader({
  title, saved, saving, onSave, onReset, canSave,
}: {
  title: string
  saved: boolean
  saving: boolean
  onSave: () => void
  onReset: () => void
  canSave: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <div className="flex items-center gap-3">
        {saved && <span className="text-xs text-green-600">Saved</span>}
        <button
          type="button"
          onClick={onReset}
          title="Reset to default"
          aria-label="Reset to default"
          className="inline-flex items-center justify-center h-[30px] w-[30px] rounded-lg border border-cream-border text-muted hover:border-brand hover:text-brand transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !canSave}
          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-light transition-colors disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  )
}

const GENERAL_KEYS = [
  "operationalFee", "packingFee", "markupPct", "dpPercent", "defaultPricingMethod", "defaultCountryId",
] as const satisfies readonly (keyof ProductDefaults)[]

function GeneralCard({ defaults, setDefaults, loadError, countries }: ProductDefaultsCardProps & { countries: CountryRow[] }) {
  const { saving, error, saved, handleSave, handleReset } = useCardSave(defaults, setDefaults, GENERAL_KEYS)

  function field(key: keyof ProductDefaults, value: string) {
    setDefaults((d) => (d ? { ...d, [key]: Number(value) || 0 } : d))
  }

  // Separate from field(): that one coerces with `Number(value) || 0`, which cannot express the
  // null this column uses to mean "start the form on IDR".
  function setDefaultCountry(value: string) {
    setDefaults((d) => (d ? { ...d, defaultCountryId: value === "" ? null : Number(value) } : d))
  }

  // Also separate from field(): this one is a string union, not a number.
  function setDefaultPricingMethod(value: string) {
    setDefaults((d) => (d ? { ...d, defaultPricingMethod: toPricingMethod(value) } : d))
  }

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <CardHeader title="General" saved={saved} saving={saving} onSave={handleSave} onReset={handleReset} canSave={!!defaults} />

      {loadError && <p className="text-xs text-red-600">{loadError}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!defaults && !loadError && <p className="text-xs text-muted">Loading…</p>}

      {defaults && (
        <div className="grid md:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted">Operational fee</span>
              <InfoTooltip text="Pre-filled into the Add Product form. Editing this doesn't change any existing product." />
            </div>
            <input
              type="number"
              value={defaults.operationalFee}
              onChange={(e) => field("operationalFee", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted">Packing fee</span>
              <InfoTooltip text="Pre-filled into the Add Product form. Editing this doesn't change any existing product." />
            </div>
            <input
              type="number"
              value={defaults.packingFee}
              onChange={(e) => field("packingFee", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Markup rate %</span>
            <input
              type="number"
              value={defaults.markupPct}
              onChange={(e) => field("markupPct", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted">Down Payment %</span>
              <InfoTooltip text="Customers below this % of an event's total get the DP reminder message instead of the invoice message. 0 = feature off." />
            </div>
            <input
              type="number"
              min={0}
              max={100}
              value={defaults.dpPercent}
              onChange={(e) => field("dpPercent", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted">Default pricing</span>
              <InfoTooltip text="Which tab the Add Product form opens on. Profit Margin and both Rate methods need a country, so pair one of those with a Default country below or the form opens with that field empty." />
            </div>
            <select
              value={defaults.defaultPricingMethod}
              onChange={(e) => setDefaultPricingMethod(e.target.value)}
              className={fieldInputCls}
            >
              {PRICING_METHODS.map((m) => (
                <option key={m} value={m}>{PRICING_METHOD_LABEL[m]}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted">Default country</span>
              <InfoTooltip text="Which country the Add Product form starts on. For Markup and Flat Fee this also decides whether that form opens with a typed base cost (IDR) or one derived from valas." />
            </div>
            <select
              value={defaults.defaultCountryId != null ? String(defaults.defaultCountryId) : ""}
              onChange={(e) => setDefaultCountry(e.target.value)}
              className={fieldInputCls}
            >
              {/* Empty value = NULL = no country, which the Add Product form shows as
                  "IDR (Rupiah)". A real option, not a placeholder. */}
              <option value="">IDR (Rupiah)</option>
              {countries.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  )
}

const PROFIT_MARGIN_KEYS = [
  "profitPct", "profitMarginRoundTo",
] as const satisfies readonly (keyof ProductDefaults)[]

// Ahead of Markup Flat because the per-method cards run in PRICING_METHODS order, and
// `overseas` is first.
//
// Unlike the Markup Flat figures below, Profit % IS a pre-fill: every Profit Margin
// product stores its own profit_pct, and the server prices from the row's copy, so
// changing this moves nothing that already exists.
function ProfitMarginCard({ defaults, setDefaults, loadError }: ProductDefaultsCardProps) {
  const { saving, error, saved, handleSave, handleReset } = useCardSave(defaults, setDefaults, PROFIT_MARGIN_KEYS)
  const [tryBaseProfit, setTryBaseProfit] = useState("300000")

  function field(key: keyof ProductDefaults, value: string) {
    setDefaults((d) => (d ? { ...d, [key]: Number(value) || 0 } : d))
  }

  // Same formula calcAbroadPrice runs server-side, minus the valas→cost conversion: this
  // box's typed number IS the cost, the same simplification Markup Tier/Flat's preview
  // makes. Operational/packing fees come from the General card, also part of `defaults`.
  // Broken into the same steps the formula actually takes, so the box explains the
  // arithmetic instead of just the result.
  const previewProfitBase = Number(tryBaseProfit) || 0
  const previewDivided =
    defaults && defaults.profitPct < 100
      ? (previewProfitBase * 100) / (100 - defaults.profitPct)
      : 0
  const previewRawTotal = defaults ? previewDivided + defaults.operationalFee + defaults.packingFee : 0
  const previewProfitPrice =
    !defaults || defaults.profitPct >= 100 ? 0 : ceilTo(previewRawTotal, defaults.profitMarginRoundTo)

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <CardHeader title="Profit Margin" saved={saved} saving={saving} onSave={handleSave} onReset={handleReset} canSave={!!defaults} />

      <p className="text-xs text-muted">
        Price is cost ÷ (1 − Profit %), plus the operational and packing fees, rounded up to
        the step below.
      </p>

      {loadError && <p className="text-xs text-red-600">{loadError}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!defaults && !loadError && <p className="text-xs text-muted">Loading…</p>}

      {defaults && (
        <div className="grid md:grid-cols-4 gap-3">
          <label className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted">Profit %</span>
              <InfoTooltip text="What the Add Product form starts on. Each product keeps its own copy, so editing this changes nothing that already exists. 100 or more leaves nothing to divide into, and the price computes as 0." />
            </div>
            <input
              type="number"
              value={defaults.profitPct}
              onChange={(e) => field("profitPct", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted">Rounding</span>
              {/* Unlike Profit % beside it, this is not a pre-fill — every Profit Margin
                  product is rounded by whatever this holds when it is saved. */}
              <InfoTooltip text="Prices round UP to this step. Separate from the Rate card's step, and read on a product's next save — so changing it reprices each one then, not now." />
            </div>
            <input
              type="number"
              min="1"
              step="1"
              value={defaults.profitMarginRoundTo}
              onChange={(e) => field("profitMarginRoundTo", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          {/* Read-only: these two belong to the General card and feed this formula, but
              editing them here would mean two Saves owning the same field. Shown so the
              breakdown below is self-contained instead of sending the owner to scroll up. */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Operational fee</span>
            <div
              title="Set in the General card above"
              className={`${fieldInputCls} bg-surface-muted text-faint cursor-not-allowed`}
            >
              {defaults.operationalFee}
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Packing fee</span>
            <div
              title="Set in the General card above"
              className={`${fieldInputCls} bg-surface-muted text-faint cursor-not-allowed`}
            >
              {defaults.packingFee}
            </div>
          </label>

          <div className="col-span-4 rounded-lg bg-surface-muted border border-cream-border px-3 py-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-muted">Try a base cost</span>
              <MoneyInput value={tryBaseProfit} onChange={setTryBaseProfit} name="try-base-profit-margin" wrapClassName="w-32 shrink-0" />
            </div>
            {defaults.profitPct >= 100 ? (
              <p className="text-xs text-amber-700 tabular-nums">
                Profit % is 100 or more — nothing to divide into, so the price computes as
                Rp 0.
              </p>
            ) : (
              <>
                <p className="text-xs text-faint tabular-nums">
                  Rp {fmt(previewProfitBase)} ÷ (1 − {fmt(defaults.profitPct)}%) = Rp {fmt(previewDivided)}
                </p>
                <p className="text-xs text-muted tabular-nums">
                  + Rp {fmt(defaults.operationalFee)} operational + Rp {fmt(defaults.packingFee)} packing
                  {` = Rp ${fmt(previewRawTotal)}, rounded up to ${fmt(defaults.profitMarginRoundTo)}`}
                </p>
              </>
            )}
            <p className="text-xs text-muted tabular-nums">
              price <span className="font-semibold text-foreground">Rp {fmt(previewProfitPrice)}</span>
              {" · cost Rp "}{fmt(previewProfitBase)}
              {" · profit "}
              <span className={previewProfitPrice - previewProfitBase >= 0 ? "text-green-700" : "text-red-600"}>
                Rp {fmt(previewProfitPrice - previewProfitBase)}
              </span>
            </p>
            {defaults.profitPct < 100 && previewProfitPrice !== Math.round(previewRawTotal) && (
              <p className="text-[10px] text-faint tabular-nums">
                The rounding added Rp {fmt(previewProfitPrice - Math.round(previewRawTotal))} on top of the
                margin and fees.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const CUSTOM_REQUEST_KEYS = [
  "customRequestProfitPct", "customRequestOperationalFee", "customRequestPackingFee", "tierKursSites",
] as const satisfies readonly (keyof ProductDefaults)[]

// Own card, own Save, even though the shape mirrors Profit Margin above: this is the
// starting formula order-requests' "Propose a price revision" and "Create product from
// approved offer" modals compute from (migration 090), meant to mirror the customer-facing
// site's own live-estimate formula rather than the Add Product form's Profit Margin figures.
function CustomRequestEstimateCard({ defaults, setDefaults, loadError }: ProductDefaultsCardProps) {
  const { saving, error, saved, handleSave, handleReset } = useCardSave(defaults, setDefaults, CUSTOM_REQUEST_KEYS)

  function field(key: keyof ProductDefaults, value: string) {
    setDefaults((d) => (d ? { ...d, [key]: Number(value) || 0 } : d))
  }

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <CardHeader title="Custom Request Estimate" saved={saved} saving={saving} onSave={handleSave} onReset={handleReset} canSave={!!defaults} />

      <p className="text-xs text-muted">
        Starting formula for order-requests&apos; price-revision and create-product flows —
        keep this matching the customer-facing site&apos;s own estimate.
      </p>

      {loadError && <p className="text-xs text-red-600">{loadError}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!defaults && !loadError && <p className="text-xs text-muted">Loading…</p>}

      {defaults && (
        <div className="grid md:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted">Profit %</span>
              <InfoTooltip text="What a fresh price revision or create-product proposal starts from. 0-99 only." />
            </div>
            <input
              type="number"
              min={0}
              max={99}
              value={defaults.customRequestProfitPct}
              onChange={(e) => field("customRequestProfitPct", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted">Op Fee</span>
              <InfoTooltip text="Starting operational fee for the same two flows. Whole number, 0 or more." />
            </div>
            <input
              type="number"
              min={0}
              step={1}
              value={defaults.customRequestOperationalFee}
              onChange={(e) => field("customRequestOperationalFee", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted">Pack Fee</span>
              <InfoTooltip text="Starting packing fee for the same two flows. Whole number, 0 or more." />
            </div>
            <input
              type="number"
              min={0}
              step={1}
              value={defaults.customRequestPackingFee}
              onChange={(e) => field("customRequestPackingFee", e.target.value)}
              className={fieldInputCls}
            />
          </label>
        </div>
      )}

      {defaults && (
        <label className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted">Tier Kurs sites</span>
            <InfoTooltip text="One bare domain per line (no https://, no www). A URL in a request's note/description matching one of these pre-selects the Tier Kurs tab instead of Profit Margin." />
          </div>
          <textarea
            rows={3}
            value={defaults.tierKursSites.join("\n")}
            onChange={(e) =>
              setDefaults((d) =>
                d ? { ...d, tierKursSites: e.target.value.split("\n") } : d,
              )
            }
            className={`${fieldInputCls} font-mono`}
            placeholder="24028-net.jp&#10;zara.com"
          />
        </label>
      )}
    </div>
  )
}

const MARKUP_FLAT_KEYS = [
  "flatFee", "flatFeePct", "flatFeeMin",
] as const satisfies readonly (keyof ProductDefaults)[]

// The three figures behind Markup's Flat toggle. Their own card because they are not form
// pre-fills like the rest of Product defaults: the SERVER re-reads all three inside the
// write transaction, so they are the authority over what a Flat Fee product is priced at
// — the same distinction Tier Kurs rounding carries, one card up.
function MarkupFlatCard({ defaults, setDefaults, loadError }: ProductDefaultsCardProps) {
  const { saving, error, saved, handleSave, handleReset } = useCardSave(defaults, setDefaults, MARKUP_FLAT_KEYS)
  // Independent per box: fixed mode's fee doesn't depend on base cost, so there's nothing to
  // vary there other than seeing base + a constant; percent mode is the one worth trying
  // different base costs against, to see where the minimum floor kicks in.
  const [tryBaseFlat, setTryBaseFlat] = useState("300000")
  const [tryBasePct, setTryBasePct] = useState("300000")

  function field(key: keyof ProductDefaults, value: string) {
    setDefaults((d) => (d ? { ...d, [key]: Number(value) || 0 } : d))
  }

  const previewFlatBase = Number(tryBaseFlat) || 0
  const previewFlatFee = defaults?.flatFee ?? 0
  const previewFlatPrice = calcRupiahFeePrice(previewFlatBase, previewFlatFee)

  const previewPctBase = Number(tryBasePct) || 0
  const previewPctFee = defaults
    ? flatFeeAmount("percent", previewPctBase, defaults.flatFee, defaults.flatFeePct, defaults.flatFeeMin)
    : 0
  const previewPctFloored = defaults
    ? flatFeeFloorApplies("percent", previewPctBase, defaults.flatFeePct, defaults.flatFeeMin)
    : false
  const previewPctPrice = calcRupiahFeePrice(previewPctBase, previewPctFee)

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <CardHeader title="Markup Flat" saved={saved} saving={saving} onSave={handleSave} onReset={handleReset} canSave={!!defaults} />

      <p className="text-xs text-muted">
        What a Flat Fee product earns — the Flat side of Markup&apos;s Tier | Flat toggle.
        Read when a product is saved, so every Flat Fee product uses the same figures.
      </p>

      {loadError && <p className="text-xs text-red-600">{loadError}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!defaults && !loadError && <p className="text-xs text-muted">Loading…</p>}

      {defaults && (
        <div className="grid md:grid-cols-2 gap-3">
          <div className="border border-cream-border rounded-lg p-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted">Flat Fee</span>
                <InfoTooltip text="Every Flat Fee product is priced base cost + this. Applies on a product's next save." />
              </div>
              <input
                type="number"
                min="0"
                value={defaults.flatFee}
                onChange={(e) => field("flatFee", e.target.value)}
                className={fieldInputCls}
              />
            </label>

            <div className="rounded-lg bg-surface-muted border border-cream-border px-3 py-2 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-muted">Try a base cost</span>
                <MoneyInput value={tryBaseFlat} onChange={setTryBaseFlat} name="try-base-flat-fee" wrapClassName="w-32 shrink-0" />
              </div>
              <p className="text-xs text-muted tabular-nums">
                fee <span className="font-semibold text-foreground">Rp {fmt(previewFlatFee)}</span>
                {" → price "}
                <span className="font-semibold text-foreground">Rp {fmt(previewFlatPrice)}</span>
              </p>
            </div>
          </div>
          <div className="border border-cream-border rounded-lg p-3 grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted">Flat Percentage</span>
                <InfoTooltip text="Used instead of the amount above by Flat Fee products with Percent switched on. Applies on a product's next save." />
              </div>
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={defaults.flatFeePct}
                onChange={(e) => field("flatFeePct", e.target.value)}
                className={fieldInputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted">Minimum fee</span>
                <InfoTooltip text="Floor under the percentage above, for when a small base would earn less than the work costs. 0 = no floor. Percent mode only." />
              </div>
              <input
                type="number"
                min="0"
                value={defaults.flatFeeMin}
                onChange={(e) => field("flatFeeMin", e.target.value)}
                className={fieldInputCls}
              />
            </label>

            <div className="col-span-2 rounded-lg bg-surface-muted border border-cream-border px-3 py-2 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-muted">Try a base cost</span>
                <MoneyInput value={tryBasePct} onChange={setTryBasePct} name="try-base-flat-pct" wrapClassName="w-32 shrink-0" />
              </div>
              <p className="text-xs text-muted tabular-nums">
                {fmt(defaults.flatFeePct)}% = Rp {fmt(previewPctFee)}
                {previewPctFloored && " (floored)"}
                {" — fee "}
                <span className="font-semibold text-foreground">Rp {fmt(previewPctFee)}</span>
                {" → price "}
                <span className="font-semibold text-foreground">Rp {fmt(previewPctPrice)}</span>
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TemplateSection({ templateKey, initialBody }: { templateKey: TemplateKey; initialBody: string }) {
  const [body, setBody] = useState(initialBody)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(t)
  }, [saved])

  const missing = findMissingTokens(body, templateKey)
  const preview = fillTemplate(body, SAMPLE_VARS[templateKey])

  async function handleSave() {
    if (missing.length > 0) {
      setError(`Missing required token(s): ${missing.join(", ")}`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/message-templates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: templateKey, body }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to save")
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    setBody(DEFAULT_TEMPLATES[templateKey])
    setError(null)
  }

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-foreground">{TEMPLATE_LABELS[templateKey]}</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-green-600">Saved</span>}
          <button
            type="button"
            onClick={handleReset}
            title="Reset to default"
            aria-label="Reset to default"
            className="inline-flex items-center justify-center h-[30px] w-[30px] rounded-lg border border-cream-border text-muted hover:border-brand hover:text-brand transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-light transition-colors disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <p className="text-xs text-muted">
        Required tokens:{" "}
        {REQUIRED_TOKENS[templateKey].map((t) => (
          <code
            key={t}
            className={`mx-0.5 px-1 py-0.5 rounded ${missing.includes(t) ? "bg-red-100 text-red-600" : "bg-cream text-muted-strong"}`}
          >
            {t}
          </code>
        ))}
        {OPTIONAL_TOKENS[templateKey].length > 0 && (
          <>
            {" "}· Optional:{" "}
            {OPTIONAL_TOKENS[templateKey].map((t) => (
              <code
                key={t}
                title={body.includes(t) ? undefined : "Not in the template — its content will be left out of the message"}
                className={`mx-0.5 px-1 py-0.5 rounded ${body.includes(t) ? "bg-cream text-faint" : "bg-amber-100 text-amber-700"}`}
              >
                {t}
              </code>
            ))}
          </>
        )}
      </p>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="grid md:grid-cols-2 gap-3">
        <textarea
          value={body}
          onChange={(e) => { setBody(e.target.value); setError(null) }}
          className={textareaCls}
          spellCheck={false}
        />
        <div className="border border-cream-border rounded-lg px-3 py-2 bg-cream overflow-auto">
          <p className="text-[10px] uppercase tracking-wide text-faint mb-1">Preview</p>
          <pre className="text-xs whitespace-pre-wrap font-sans text-foreground">{preview}</pre>
        </div>
      </div>
    </div>
  )
}

// ─── Inbox notices ───────────────────────────────────────────────────────────
//
// A box of its own, below the WhatsApp templates and deliberately not mixed in
// with them: these are not copied by hand into a chat, they are sent from the
// invoice screen and land in the customer's own inbox on the catalogue. Same
// idea, different destination, and the tokens are a different set.

const NOTICE_SAMPLE: NoticeTokens = {
  "{customer}": "@fandrianr",
  "{event}": "LSJP202601",
  "{total}": "Rp 3.890.000",
  "{outstanding}": "Rp 1.900.000",
  "{refundAmount}": "Rp 240.000",
  "{itemsList}": "Muji Gel Pen 0.38 × 2",
  "{cause}": "We could not buy Muji Gel Pen 0.38 × 2 from LSJP202601.",
}

function InboxNoticesSection() {
  const [overrides, setOverrides] = useState<Partial<Record<NoticeKey, NoticeOverride>> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/sheets/notice-templates", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { overrides?: Partial<Record<NoticeKey, NoticeOverride>>; error?: string }) => {
        if (data.error) setLoadError(data.error)
        else setOverrides(data.overrides ?? {})
      })
      .catch(() => setLoadError("Failed to load inbox notices"))
  }, [])

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Inbox notices</h2>
        <p className="text-xs text-muted mt-1">
          What they read in their catalogue inbox when you tell them something from the invoice
          screen. Edit the wording here; the amounts and the order number fill themselves in.
          Leave a field blank to go back to ours.
        </p>
      </div>

      {loadError && <p className="text-xs text-red-600">{loadError}</p>}
      {!loadError && !overrides && <p className="text-xs text-muted">Loading…</p>}

      {overrides && (
        <div className="flex flex-col gap-4">
          {NOTICE_TEMPLATES.map((t) => (
            <NoticeTemplateRow key={t.key} template={t} initial={overrides[t.key]} />
          ))}
        </div>
      )}
    </div>
  )
}

function NoticeTemplateRow({
  template, initial,
}: { template: NoticeTemplate; initial?: NoticeOverride }) {
  const [title, setTitle] = useState(initial?.title?.trim() ? initial.title : template.title)
  const [body, setBody] = useState(initial?.body?.trim() ? initial.body : template.body)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(t)
  }, [saved])

  const bad = unknownTokens(`${title} ${body}`)
  // Not an error — fillNotice resolves it to nothing — but a hole in a
  // sentence she reads, so it is worth seeing before it is saved.
  const known = NOTICE_TOKENS_FOR[template.key]
  const inert = NOTICE_TOKENS.filter((t) => !known.includes(t) && `${title} ${body}`.includes(t))
  const edited = title !== template.title || body !== template.body

  async function handleSave() {
    if (!title.trim()) {
      setError("A notice needs a title")
      return
    }
    if (bad.length > 0) {
      setError(`${bad.join(", ")} is not a placeholder we know`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/notice-templates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: template.key, title, body }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to save")
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    setTitle(template.title)
    setBody(template.body)
    setError(null)
  }

  return (
    <div className="border border-cream-border rounded-lg">
      <div className="flex items-center justify-between gap-2 px-3 py-2 flex-wrap">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-2 text-sm font-medium text-foreground min-w-0"
        >
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span className="truncate">{template.label}</span>
          {template.isRefund && (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-700 bg-amber-100 rounded px-1 py-0.5">
              Creates a refund
            </span>
          )}
          {edited && !open && <span className="shrink-0 text-[10px] text-muted">Edited</span>}
        </button>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-green-600">Saved</span>}
          <button
            type="button"
            onClick={handleReset}
            title="Reset to default"
            aria-label="Reset to default"
            className="inline-flex items-center justify-center h-[30px] w-[30px] rounded-lg border border-cream-border text-muted hover:border-brand hover:text-brand transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-light transition-colors disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {open && (
        <div className="px-3 pb-3 flex flex-col gap-3">
          <p className="text-xs text-muted">
            Placeholders:{" "}
            {known.map((t) => (
              <code
                key={t}
                className={`mx-0.5 px-1 py-0.5 rounded ${
                  `${title} ${body}`.includes(t) ? "bg-cream text-muted-strong" : "bg-cream text-faint"
                }`}
              >
                {t}
              </code>
            ))}
            {inert.length > 0 && (
              <>
                {" "}· Fills with nothing here:{" "}
                {inert.map((t) => (
                  <code key={t} className="mx-0.5 px-1 py-0.5 rounded bg-amber-100 text-amber-700">
                    {t}
                  </code>
                ))}
              </>
            )}
          </p>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="grid md:grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <label className="text-[10px] uppercase tracking-wide text-faint" htmlFor={`notice-title-${template.key}`}>
                Title
              </label>
              <input
                id={`notice-title-${template.key}`}
                value={title}
                onChange={(e) => { setTitle(e.target.value); setError(null) }}
                className={`${fieldInputCls} font-mono`}
                spellCheck={false}
              />
              <label className="text-[10px] uppercase tracking-wide text-faint" htmlFor={`notice-body-${template.key}`}>
                Message
              </label>
              <textarea
                id={`notice-body-${template.key}`}
                value={body}
                onChange={(e) => { setBody(e.target.value); setError(null) }}
                className={`${textareaCls} min-h-[140px]`}
                spellCheck={false}
              />
            </div>
            <div className="border border-cream-border rounded-lg px-3 py-2 bg-cream overflow-auto">
              <p className="text-[10px] uppercase tracking-wide text-faint mb-1">Preview</p>
              <p className="text-xs font-semibold text-foreground mb-1">{fillNotice(title, NOTICE_SAMPLE)}</p>
              <pre className="text-xs whitespace-pre-wrap font-sans text-foreground">
                {fillNotice(body, NOTICE_SAMPLE)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
