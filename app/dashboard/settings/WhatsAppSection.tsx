"use client"

import { useEffect, useState } from "react"
import EventSelect from "@/components/EventSelect"
import { PRICING_METHODS, PRICING_METHOD_LABEL, toPricingMethod } from "@/lib/pricing"
import { DEFAULT_PRODUCT_DEFAULTS, type ProductDefaults } from "@/lib/product-defaults"

interface Group {
  jid: string
  name: string
  event: string | null
}

interface Admin {
  number: string
  label: string
  canConnect: boolean
}

const inputCls =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

export default function WhatsAppSection() {
  const [groups, setGroups] = useState<Group[]>([])
  const [admins, setAdmins] = useState<Admin[]>([])
  const [events, setEvents] = useState<string[]>([])
  // The customer-facing link per running trip. Normally handed out by the bot
  // with /katalog; here for a caption, a group not connected yet, or simply
  // checking what customers can see.
  const [links, setLinks] = useState<{ event: string; url: string; shelves: number }[]>([])
  /**
   * What just saved, and what went wrong.
   *
   * These controls write the moment they change — there is no Save to press —
   * which is only reassuring if the screen says so. Worse before this: neither
   * handler checked the response, so a failed save looked exactly like a
   * successful one.
   */
  const [savedKey, setSavedKey] = useState("")
  const [saveError, setSaveError] = useState("")

  function acknowledge(key: string) {
    setSaveError("")
    setSavedKey(key)
    window.setTimeout(() => setSavedKey((k) => (k === key ? "" : k)), 2000)
  }

  const [copied, setCopied] = useState("")
  const [defaults, setDefaults] = useState<ProductDefaults>(DEFAULT_PRODUCT_DEFAULTS)
  const [error, setError] = useState("")

  const [number, setNumber] = useState("")
  const [label, setLabel] = useState("")
  const [canConnect, setCanConnect] = useState(false)

  function reload() {
    fetch("/api/whatsapp/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { groups?: Group[]; admins?: Admin[]; error?: string }) => {
        if (d.error) setError(d.error)
        else {
          setGroups(d.groups ?? [])
          setAdmins(d.admins ?? [])
        }
      })
      .catch(() => setError("Failed to load"))
  }

  useEffect(() => {
    reload()
    loadLinks()
    fetch("/api/sheets/options", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { events?: string[] }) => setEvents(d.events ?? []))
      .catch(() => {})
    fetch("/api/sheets/product-defaults", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { defaults?: ProductDefaults }) => d.defaults && setDefaults(d.defaults))
      .catch(() => {})
  }, [])

  async function loadLinks() {
    const res = await fetch("/api/whatsapp/katalog", { cache: "no-store" })
    if (!res.ok) return
    const data = (await res.json()) as { links?: { event: string; url: string; shelves: number }[] }
    setLinks(data.links ?? [])
  }

  /** Mint the first link for a trip. Nothing exists until this is pressed. */
  async function createLink(event: string) {
    const res = await fetch("/api/whatsapp/katalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, action: "create" }),
    })
    if (!res.ok) { setSaveError("Could not create that link"); return }
    loadLinks()
  }

  async function rotate(event: string) {
    // Everyone holding the old URL loses access; every other trip keeps its own.
    if (!confirm(`Retire the current link for ${event} and issue a new one?`)) return
    await fetch("/api/whatsapp/katalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event }),
    })
    loadLinks()
  }

  async function bind(jid: string, event: string) {
    const res = await fetch("/api/whatsapp/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jid, event: event || null }),
    })
    if (!res.ok) {
      setSaveError("Could not change that group's trip")
      reload()
      return
    }
    acknowledge(`group:${jid}`)
    reload()
  }

  async function addAdmin() {
    if (!number.trim()) return
    await fetch("/api/whatsapp/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number, label, canConnect }),
    })
    setNumber("")
    setLabel("")
    setCanConnect(false)
    reload()
  }

  async function saveMethod(value: string) {
    const method = toPricingMethod(value)
    const previous = defaults?.whatsappPricingMethod
    setDefaults((d) => ({ ...d, whatsappPricingMethod: method }))
    const res = await fetch("/api/sheets/product-defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ whatsappPricingMethod: method }),
    })
    if (!res.ok) {
      // Put the control back to what is actually stored. Leaving the new value
      // on screen after a failed write is the one outcome worse than no
      // feedback at all.
      setDefaults((d) => ({ ...d, whatsappPricingMethod: previous }))
      setSaveError("Could not change the pricing method")
      return
    }
    acknowledge("pricing")
  }

  return (
    <div className="flex flex-col gap-6">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {saveError ? <p className="text-sm text-red-600">{saveError}</p> : null}

      <section className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Groups</h2>
        <p className="text-xs text-muted">
          Groups outlive trips. Bind one to the event whose claims it collects, and
          re-bind it next trip rather than starting a new group.
        </p>
        {groups.length === 0 ? (
          <p className="text-xs text-muted">
            No groups yet. Invite the bot to a group and connect it from there.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.jid} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 text-sm truncate">{group.name || group.jid}</span>
              {savedKey === `group:${group.jid}` && (
                <span className="shrink-0 text-xs text-green-700">Saved</span>
              )}
              <div className="w-56 shrink-0">
                <EventSelect
                  value={group.event ?? ""}
                  onChange={(v) => bind(group.jid, v)}
                  events={events}
                  placeholder="Not connected"
                  clearable
                  dense
                />
              </div>
            </div>
          ))
        )}
      </section>

      <section className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Catalogue links</h2>
        <p className="text-xs text-muted">
          For whoever joined the group after its shelves were posted.
          Unguessable, and only while the trip is open — closing it takes the
          link dark. Rotating retires the old URL for everyone holding it, and
          leaves other trips alone.
        </p>
        {links.length === 0 && (
          <p className="text-xs text-faint">
            No running trip has shelves yet. A link appears here once photographs are posted.
          </p>
        )}
        {links.map((link) => (
          <div key={link.event} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">
                {link.event}
                <span className="ml-1.5 text-[11px] font-normal text-faint">
                  {link.shelves} {link.shelves === 1 ? "shelf" : "shelves"}
                </span>
              </div>
              {/* A trip that has never been published shows no URL, because it
                  has none — the secret is minted when the link is asked for,
                  not when this page is opened. */}
              <div className="text-[11px] text-muted font-mono truncate">
                {link.url || <span className="text-faint font-sans italic">no link yet</span>}
              </div>
            </div>
            {link.url ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(link.url)
                    setCopied(link.event)
                  }}
                  className="shrink-0 rounded-lg border border-cream-border px-3 py-1.5 text-xs font-semibold hover:border-brand hover:text-brand transition-colors"
                >
                  {copied === link.event ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={() => rotate(link.event)}
                  className="shrink-0 rounded-lg border border-cream-border px-3 py-1.5 text-xs font-semibold text-brand hover:border-brand transition-colors"
                >
                  Rotate
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => createLink(link.event)}
                className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark transition-colors"
              >
                Create link
              </button>
            )}
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Who may command the bot</h2>
        <p className="text-xs text-muted">
          The app&apos;s own roles key on email, and a WhatsApp sender has a number
          and no login — so the bot needs its own list. Anyone here can pull the
          shopping list; only a connector may bind a group to an event.
        </p>

        {admins.map((admin) => (
          <div key={admin.number} className="flex items-center gap-2 text-sm">
            <span className="font-mono text-xs">{admin.number}</span>
            <span className="text-muted flex-1 min-w-0 truncate">{admin.label}</span>
            {admin.canConnect ? (
              <span className="text-[10px] font-bold tracking-wide text-brand">CONNECTOR</span>
            ) : null}
            <button
              type="button"
              onClick={async () => {
                await fetch(`/api/whatsapp/settings?number=${encodeURIComponent(admin.number)}`, {
                  method: "DELETE",
                })
                reload()
              }}
              className="text-xs text-red-600 hover:underline"
            >
              Remove
            </button>
          </div>
        ))}

        <div className="grid grid-cols-2 gap-2">
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="08…  or  62…"
            className={inputCls}
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Whose number is it"
            className={inputCls}
          />
          <label className="flex items-center gap-2 text-xs text-muted-strong">
            <input
              type="checkbox"
              checked={canConnect}
              onChange={(e) => setCanConnect(e.target.checked)}
            />
            May connect a group to an event
          </label>
          <button
            type="button"
            onClick={addAdmin}
            className="rounded-lg bg-brand py-2 text-sm font-semibold text-white"
          >
            Add
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Pricing for group posts</h2>
          {/* Saves on change — no button to press — so it says when it has. */}
          {savedKey === "pricing" && <span className="text-xs text-green-700">Saved</span>}
        </div>
        <p className="text-xs text-muted">
          Which method a shelf photographed into a group starts on. Separate from the
          Add Product form&apos;s default, because the shops you photograph are
          priced differently from what you type in by hand.
        </p>
        <select
          value={defaults.whatsappPricingMethod}
          onChange={(e) => saveMethod(e.target.value)}
          className={`${inputCls} max-w-xs`}
        >
          {PRICING_METHODS.map((method) => (
            <option key={method} value={method}>
              {PRICING_METHOD_LABEL[method]}
            </option>
          ))}
        </select>
      </section>
    </div>
  )
}
