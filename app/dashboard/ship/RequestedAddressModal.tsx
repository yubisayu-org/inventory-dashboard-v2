"use client"

import { useEffect, useRef, useState } from "react"
import { displayIg } from "@/lib/format"
import { useModalDismiss } from "@/hooks/useModalDismiss"

type Area = { id: string; name: string }

/**
 * Write down a redirect she asked for.
 *
 * Her own page can record this, and when she uses it the request waits on the
 * trip until a box goes. Said on WhatsApp it had nowhere to live but somebody's
 * memory, and she asks early -- often weeks before anything arrives, which is
 * exactly how long the memory has to last.
 *
 * It writes the same field her page writes, so from here on the two are one
 * thing: the card badges it, the ship sheet fills it in, and the parcel that
 * uses it spends it.
 */
export function RequestedAddressModal({
  customer,
  event,
  current,
  initial,
  profile,
  onClose,
  onSaved,
}: {
  customer: string
  event: string
  /** Whether a redirect is already recorded, which is what Hapus needs. */
  current: string | null
  /** What is recorded, in the parts the form edits. */
  initial: { name: string; phone: string; street: string; areaId: string; areaName: string }
  /** Her own details, so a blank form opens on where she actually lives — the
   *  same start her own sheet gets, since a redirect is nearly always a small
   *  edit to that. */
  profile: { name: string; phone: string; street: string }
  onClose: () => void
  onSaved: () => void
}) {
  useModalDismiss(onClose)

  const started = Boolean(initial.street)
  const [who, setWho] = useState(started ? initial.name || profile.name : profile.name)
  const [phone, setPhone] = useState(started ? initial.phone || profile.phone : profile.phone)
  const [address, setAddress] = useState(started ? initial.street : profile.street)
  const [query, setQuery] = useState("")
  const [areas, setAreas] = useState<Area[]>([])
  const [area, setArea] = useState<Area | null>(
    initial.areaId ? { id: initial.areaId, name: initial.areaName } : null,
  )
  const [quote, setQuote] = useState<
    { perKg: number | null; usualPerKg: number; weightKg: number; delta: number } | null
  >(null)
  const [quoting, setQuoting] = useState(false)
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [areaError, setAreaError] = useState<string | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // The same question her sheet asks, answered by the same code, so the figure
  // she was quoted and the figure staff see cannot differ.
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

  // What the courier is handed, exactly as her own screens draw it — captions
  // and all, each dropping out with the field it names.
  const label = [
    who.trim() ? `Nama: ${who.trim()}` : "",
    phone.trim() ? `Telepon: ${phone.trim()}` : "",
    address.trim() || area ? "Alamat Lengkap:" : "",
    address.trim(),
    area?.name ?? "",
  ].filter(Boolean).join("\n")

  async function save(next: string, keepArea: boolean) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/ship/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "address",
          customer,
          events: [event],
          address: next,
          areaId: keepArea ? area?.id ?? null : null,
          areaName: keepArea ? area?.name ?? null : null,
          name: keepArea ? who.trim() : "",
          phone: keepArea ? phone.trim() : "",
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Gagal menyimpan alamat")
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan alamat")
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto flex flex-col gap-3 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-sm font-semibold text-foreground">Alamat lain untuk paket ini</h3>
          <p className="text-xs text-muted mt-1">
            {displayIg(customer)} · {event}
          </p>
        </div>

        {/* The same fields her own sheet asks for, in the same order. A
            parcel going to her mother's house wants her mother's name and the
            phone that will actually be answered. */}
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Nama penerima</span>
            <input
              value={who}
              onChange={(e) => setWho(e.target.value)}
              disabled={saving}
              className="w-full px-3 py-2 rounded-lg border border-cream-border text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Telepon</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={saving}
              className="w-full px-3 py-2 rounded-lg border border-cream-border text-sm"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Alamat</span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={saving}
            placeholder="Jalan, nomor, patokan"
            className="w-full px-3 py-2 rounded-lg border border-cream-border text-sm"
          />
        </label>

        {/* The area is not decoration. Her ongkir was priced for where she
            lives; a redirect somewhere else may cost differently, and without
            an area on the record nothing can tell the two apart. */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">
            Area <span className="font-normal text-faint">(kecamatan / kode pos)</span>
          </span>
          {area ? (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cream-border text-sm">
              <span className="flex-1 min-w-0 truncate">{area.name}</span>
              <button
                type="button"
                onClick={() => { setArea(null); setQuery("") }}
                disabled={saving}
                className="text-xs text-faint hover:text-brand"
              >
                Ganti
              </button>
            </div>
          ) : (
            <>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={saving}
                placeholder="mis. Kebayoran Baru"
                className="w-full px-3 py-2 rounded-lg border border-cream-border text-sm"
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
        </label>

        {/* What sending it there costs, before it is saved. */}
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
                ? "Kurir tidak memberi harga untuk area ini. Ongkirnya tidak akan disesuaikan otomatis — cek manual."
                : quote.delta === 0
                  ? `Rp ${quote.perKg.toLocaleString("id-ID")}/kg, sama dengan area lamanya. Tagihannya tidak berubah.`
                  : `Rp ${quote.perKg.toLocaleString("id-ID")}/kg ke area ini, biasanya Rp ${quote.usualPerKg.toLocaleString("id-ID")}/kg. `
                    + `Paket ±${quote.weightKg} kg, jadi tagihannya ${quote.delta > 0 ? "bertambah" : "berkurang"} `
                    + `Rp ${Math.abs(quote.delta).toLocaleString("id-ID")} otomatis.`}
          </div>
        )}

        {label && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Yang tercetak di label</span>
            <pre className="whitespace-pre-wrap font-sans text-xs bg-surface-sunken border border-dashed border-cream-border rounded-lg px-3 py-2 text-muted">
              {label}
            </pre>
          </label>
        )}

        <p className="text-[11px] text-faint">
          Berlaku untuk paket berikutnya di trip ini. Setelah paketnya berangkat, catatan ini hilang
          sendiri dan paket sesudahnya kembali ke alamat profilnya.
        </p>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="flex justify-end gap-2">
          {current && (
            <button
              type="button"
              onClick={() => save("", false)}
              disabled={saving}
              className="mr-auto px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-sm hover:border-red-400 hover:text-red-500 disabled:opacity-50"
            >
              Hapus
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-sm disabled:opacity-50"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={() => save(address.trim(), true)}
            disabled={saving || !address.trim() || !area}
            title={!area ? "Pilih areanya dulu — kurir dibekali empat kotak itu, bukan baris yang diketik" : undefined}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-50"
          >
            {saving ? "Menyimpan…" : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  )
}
