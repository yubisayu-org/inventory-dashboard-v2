"use client"

import { useEffect, useRef, useState } from "react"

/**
 * Where a parcel is going, asked the one way.
 *
 * Her own page, the "Alamat lain" chip and the dispatch dialog all send
 * parcels to addresses that are not hers, and they used to ask for it three
 * different ways — a structured form on her side, a form with an area picker
 * on the card, and a bare textarea at the counter. Only the ones with an area
 * could be priced, so the third quietly shipped parcels the invoice never
 * caught up with.
 *
 * This is that question, once. Whoever is asking gets the same fields, the
 * same label, and the same figure for what it costs.
 */

export type Area = { id: string; name: string }

export interface RedirectDraft {
  name: string
  phone: string
  street: string
  area: Area | null
  /** The label as the courier reads it, built here so no caller can build a
   *  different one. */
  label: string
  /** Enough to save: an address and an area picked from the courier's list. */
  complete: boolean
}

export interface RedirectQuote {
  perKg: number | null
  usualPerKg: number
  weightKg: number
  delta: number
}

/** Captions and all, each dropping out with the field it names. */
export function composeRedirectLabel(input: {
  name: string
  phone: string
  street: string
  areaName: string
}): string {
  const lines: string[] = []
  if (input.name.trim()) lines.push(`Nama: ${input.name.trim()}`)
  if (input.phone.trim()) lines.push(`Telepon: ${input.phone.trim()}`)
  if (input.street.trim() || input.areaName.trim()) {
    lines.push("Alamat Lengkap:")
    if (input.street.trim()) lines.push(input.street.trim())
    if (input.areaName.trim()) lines.push(input.areaName.trim())
  }
  return lines.join("\n")
}

export function RedirectFields({
  customer,
  event,
  initial,
  disabled = false,
  onChange,
}: {
  customer: string
  event: string
  initial: { name: string; phone: string; street: string; area: Area | null }
  disabled?: boolean
  onChange: (draft: RedirectDraft) => void
}) {
  const [name, setName] = useState(initial.name)
  const [phone, setPhone] = useState(initial.phone)
  const [street, setStreet] = useState(initial.street)
  const [area, setArea] = useState<Area | null>(initial.area)

  const [query, setQuery] = useState("")
  const [areas, setAreas] = useState<Area[]>([])
  const [searching, setSearching] = useState(false)
  const [areaError, setAreaError] = useState<string | null>(null)
  const [quote, setQuote] = useState<RedirectQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const label = composeRedirectLabel({ name, phone, street, areaName: area?.name ?? "" })

  // The parent is told on every keystroke, so it never has to reach in here
  // for the address it is about to send.
  useEffect(() => {
    onChange({
      name, phone, street, area, label,
      complete: Boolean(street.trim() && area),
    })
    // onChange is a fresh closure on every parent render; depending on it here
    // would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, phone, street, area, label])

  // Three letters before anything is asked of the courier: "Se" matches half
  // of Indonesia, and every call is billable.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    const q = query.trim()
    if (q.length < 3) { setAreas([]); return }
    debounce.current = setTimeout(async () => {
      setSearching(true)
      setAreaError(null)
      try {
        const res = await fetch(`/api/biteship-areas?q=${encodeURIComponent(q)}`, { cache: "no-store" })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Pencarian area gagal")
        setAreas((data.areas ?? []).slice(0, 8))
      } catch (err) {
        setAreaError(err instanceof Error ? err.message : "Pencarian area gagal")
        setAreas([])
      } finally {
        setSearching(false)
      }
    }, 350)
    return () => { if (debounce.current) clearTimeout(debounce.current) }
  }, [query])

  // What sending it there does to her bill, from the same code her own sheet
  // asks — so the figure she was quoted and the figure staff see cannot differ.
  useEffect(() => {
    if (!area) { setQuote(null); return }
    let live = true
    setQuoting(true)
    fetch("/api/sheets/ship/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer, event, areaId: area.id }),
    })
      .then((r) => r.json())
      .then((d) => { if (live) setQuote(d.quote ?? null) })
      .catch(() => { if (live) setQuote(null) })
      .finally(() => { if (live) setQuoting(false) })
    return () => { live = false }
  }, [area, customer, event])

  const input = "w-full px-3 py-2 rounded-lg border border-cream-border text-sm"

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Nama penerima</span>
          <input value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} className={input} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Telepon</span>
          <input value={phone} disabled={disabled} onChange={(e) => setPhone(e.target.value)} className={input} />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Alamat</span>
        <input
          value={street}
          disabled={disabled}
          onChange={(e) => setStreet(e.target.value)}
          placeholder="Jalan, nomor, patokan"
          className={input}
        />
      </label>

      {/* The area is not decoration: the courier is handed four boxes, and it
          is the only thing that can be priced. */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">
          Area <span className="font-normal text-faint">(kecamatan / kode pos)</span>
        </span>
        {area ? (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cream-border text-sm">
            <span className="flex-1 min-w-0 truncate">{area.name}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => { setArea(null); setQuery("") }}
              className="text-xs text-faint hover:text-brand"
            >
              Ganti
            </button>
          </div>
        ) : (
          <>
            <input
              value={query}
              disabled={disabled}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="mis. Pondok Aren"
              className={input}
            />
            {searching && <span className="text-[11px] text-faint">Mencari…</span>}
            {areaError && <span className="text-[11px] text-amber-700">{areaError}</span>}
            {areas.length > 0 && (
              <div className="border border-cream-border rounded-lg divide-y divide-cream-border max-h-40 overflow-y-auto">
                {areas.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => { setArea(a); setAreas([]) }}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-surface-muted"
                  >
                    {a.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {area && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            quoting || !quote || quote.perKg === null || quote.delta === 0
              ? "border-cream-border bg-surface-muted text-muted"
              : quote.delta > 0
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : "border-green-200 bg-green-50 text-green-700"
          }`}
        >
          {quoting
            ? "Mengecek ongkir ke area ini…"
            : !quote || quote.perKg === null
              ? "Kurir tidak memberi harga untuk area ini. Ongkirnya tidak disesuaikan otomatis — cek manual."
              : quote.delta === 0
                ? `Rp ${quote.perKg.toLocaleString("id-ID")}/kg, sama dengan area lamanya. Tagihannya tidak berubah.`
                : `Rp ${quote.perKg.toLocaleString("id-ID")}/kg ke area ini, biasanya Rp ${quote.usualPerKg.toLocaleString("id-ID")}/kg. `
                  + `Paket ±${quote.weightKg} kg, jadi tagihannya ${quote.delta > 0 ? "bertambah" : "berkurang"} `
                  + `Rp ${Math.abs(quote.delta).toLocaleString("id-ID")} — dihitung ulang waktu paketnya benar-benar ditimbang.`}
        </div>
      )}

      {label && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Yang tercetak di label</span>
          <pre className="whitespace-pre-wrap font-sans text-xs bg-surface-sunken border border-dashed border-cream-border rounded-lg px-3 py-2 text-muted">
            {label}
          </pre>
        </div>
      )}
    </div>
  )
}
