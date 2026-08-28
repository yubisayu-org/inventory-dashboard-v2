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
  onClose,
  onSaved,
}: {
  customer: string
  event: string
  current: string | null
  onClose: () => void
  onSaved: () => void
}) {
  useModalDismiss(onClose)

  const [address, setAddress] = useState(current ?? "")
  const [query, setQuery] = useState("")
  const [areas, setAreas] = useState<Area[]>([])
  const [area, setArea] = useState<Area | null>(null)
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

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Alamat</span>
          <textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={saving}
            rows={3}
            placeholder={"Nama penerima\nJalan, nomor, patokan"}
            className="w-full px-3 py-2 rounded-lg border border-cream-border text-sm resize-none"
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
            disabled={saving || !address.trim()}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-50"
          >
            {saving ? "Menyimpan…" : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  )
}
