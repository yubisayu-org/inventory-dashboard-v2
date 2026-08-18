"use client"

import { useCallback, useEffect, useRef, useState } from "react"

interface Shelf {
  id: number
  store: string
  width: number
  height: number
  hues: number[]
}

/**
 * A pen colour this shelf does not already contain.
 *
 * safe_hues is computed once per shelf at capture, by scanning the photograph
 * for colours it is short of. Handing the customer one of those means her
 * circle is visible to her and to the detector — the failure it exists to
 * prevent is a green tick on a shelf full of green packaging, which happened.
 *
 * Full saturation and mid lightness, because a pale stroke does not survive
 * WhatsApp's compression on the way back.
 */
function penColour(hues: number[]): string {
  const hue = hues.length > 0 ? hues[0] : 320
  return `hsl(${hue} 100% 50%)`
}

export default function KatalogClient({ secret }: { secret: string }) {
  const [shelves, setShelves] = useState<Shelf[] | null>(null)
  const [event, setEvent] = useState("")
  const [error, setError] = useState("")
  const [open, setOpen] = useState<Shelf | null>(null)

  useEffect(() => {
    fetch(`/api/public/katalog/${secret}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("not found"))))
      .then((data: { event: string; shelves: Shelf[] }) => {
        setEvent(data.event)
        setShelves(data.shelves)
      })
      .catch(() => setError("Katalog tidak ditemukan"))
  }, [secret])

  if (error) {
    return (
      <main className="min-h-screen bg-cream flex items-center justify-center p-8">
        <p className="text-sm text-gray-500">{error}</p>
      </main>
    )
  }
  if (!shelves) {
    return (
      <main className="min-h-screen bg-cream flex items-center justify-center p-8">
        <p className="text-sm text-gray-500">Memuat…</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-cream">
      <header className="px-4 py-3 border-b border-cream-border bg-white sticky top-0 z-10">
        <h1 className="text-base font-bold text-foreground">Katalog rak</h1>
        <p className="text-xs text-gray-500 tabular-nums">
          {event} · {shelves.length} rak
        </p>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-2">
        {shelves.map((shelf) => (
          <button
            key={shelf.id}
            type="button"
            onClick={() => setOpen(shelf)}
            className="text-left"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- our own AVIF route. */}
            <img
              src={`/api/public/katalog/${secret}/shelf/${shelf.id}`}
              alt={shelf.store}
              loading="lazy"
              className="w-full aspect-[3/4] object-cover rounded-lg border border-cream-border bg-white"
            />
            <span className="block text-[11px] text-gray-500 mt-1 truncate">{shelf.store}</span>
          </button>
        ))}
      </div>

      <p className="px-4 pb-8 pt-2 text-[11px] text-gray-500 leading-snug">
        Ketuk rak untuk melihat detail dan menandai barang yang diinginkan, lalu
        kirim ke grup.
      </p>

      {open ? (
        <MarkSheet
          key={open.id}
          secret={secret}
          shelf={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </main>
  )
}

type Stroke = { x: number; y: number }[]

/**
 * One shelf, with a finger to draw on it.
 *
 * The whole point is that what she sends back is the file she was shown, not a
 * photograph of her screen: the frames align exactly, which is the best input
 * the difference detector can get. So the export happens on the canvas at the
 * image's own size, and the sharing is left to the phone.
 */
function MarkSheet({
  secret, shelf, onClose,
}: {
  secret: string
  shelf: Shelf
  onClose: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const drawing = useRef(false)
  // Fingers currently on the canvas, and whether the current one opened a
  // stroke — enough to tell a drag from the start of a pinch.
  const down = useRef(0)
  const started = useRef(false)

  const colour = penColour(shelf.hues)

  const repaint = useCallback(() => {
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!canvas || !image) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    // Thick relative to the photograph, not to the screen: a hairline circle is
    // the first thing WhatsApp's compression eats.
    ctx.lineWidth = Math.max(6, canvas.width / 150)
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.strokeStyle = colour
    for (const stroke of strokes) {
      if (stroke.length < 2) continue
      ctx.beginPath()
      ctx.moveTo(stroke[0].x, stroke[0].y)
      for (const point of stroke.slice(1)) ctx.lineTo(point.x, point.y)
      ctx.stroke()
    }
  }, [strokes, colour])

  useEffect(() => {
    const image = new Image()
    // Same-origin today; explicit so moving the file to a bucket later does not
    // silently taint the canvas and break export.
    image.crossOrigin = "anonymous"
    image.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      imageRef.current = image
      setReady(true)
    }
    image.src = `/api/public/katalog/${secret}/shelf/${shelf.id}`
  }, [secret, shelf.id])

  useEffect(repaint, [repaint, ready])

  /** Canvas coordinates from a touch, whatever size the canvas is displayed at. */
  function pointFrom(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  async function share() {
    const canvas = canvasRef.current
    if (!canvas) return
    setBusy(true)
    setSaved(null)

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9),
    )
    setBusy(false)
    if (!blob) return

    const file = new File([blob], `rak-${shelf.id}.jpg`, { type: "image/jpeg" })

    // The share sheet is the whole trick: she picks WhatsApp, then the group,
    // and what lands there is an ordinary marked reply the bot already
    // understands. Where it is unsupported, a long press on the picture is the
    // universal fallback.
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] })
        return
      } catch {
        // Cancelled, or refused. Fall through to the saveable copy.
      }
    }
    setSaved(URL.createObjectURL(blob))
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/80 flex flex-col">
      {/* Both lines start at the same left edge by construction; the close
          button is pushed to the far side and takes no part in that. */}
      <div className="flex items-start gap-3 px-3 py-2 text-white shrink-0">
        <div className="min-w-0 flex-1">
          <span className="block text-sm font-semibold leading-6 truncate">{shelf.store}</span>
          <p className="text-[11px] opacity-70 leading-snug">
            Lingkari atau centang barang yang diinginkan
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-sm leading-6 shrink-0 px-1">
          ✕
        </button>
      </div>

      {/* The canvas is never unmounted, only hidden. Remounting it gave React a
          fresh element at its default 300x150, while the effect that sizes it to
          the photograph had already run — so coming back from the preview showed
          a blank canvas that redrew the shelf squashed into that default. Hiding
          keeps the bitmap and its dimensions. */}
      <div className="flex-1 min-h-0 overflow-auto px-2">
        {saved ? (
          <div className="h-full flex flex-col items-center justify-center gap-2">
            {/* Fitted rather than full width: the action lives in the bar below,
                and a tall image pushed it off the bottom of the screen. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- a blob we just made. */}
            <img src={saved} alt="" className="max-w-full max-h-[70vh] object-contain rounded-lg" />
            <p className="text-xs text-white/80 text-center leading-snug">
              Atau tekan lama gambar di atas → Simpan
            </p>
          </div>
        ) : null}

        <canvas
            ref={canvasRef}
            onPointerDown={(e) => {
              down.current += 1
              // A second finger means she is pinching to read a tag, not
              // drawing. Whatever the first finger started is thrown away, so a
              // zoom never leaves a stray line across the shelf.
              if (down.current > 1) {
                drawing.current = false
                setStrokes((s) => (started.current ? s.slice(0, -1) : s))
                started.current = false
                return
              }
              drawing.current = true
              started.current = true
              const p = pointFrom(e)
              setStrokes((s) => [...s, [p]])
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return
              const p = pointFrom(e)
              setStrokes((s) => {
                const next = [...s]
                next[next.length - 1] = [...next[next.length - 1], p]
                return next
              })
            }}
            onPointerUp={() => {
              down.current = Math.max(0, down.current - 1)
              drawing.current = false
              started.current = false
            }}
            onPointerCancel={() => {
              down.current = 0
              drawing.current = false
              started.current = false
            }}
            // pinch-zoom rather than none: the browser keeps two-finger zoom,
            // which is how she reads the price tag, while single-pointer moves
            // still reach the canvas to draw with.
          style={{ touchAction: "pinch-zoom" }}
          className={`w-full h-auto rounded-lg select-none ${saved ? "hidden" : ""}`}
        />
      </div>

      <div className="flex items-center gap-2 p-3 shrink-0">
        {saved ? (
          <>
            <button
              type="button"
              onClick={() => {
                // The blob stays alive for the tab's lifetime otherwise, and a
                // customer flipping between shelves would accumulate megabytes.
                URL.revokeObjectURL(saved)
                setSaved(null)
              }}
              className="rounded-xl border border-white/30 px-4 py-2.5 text-sm font-semibold text-white"
            >
              Kembali
            </button>
            <a
              href={saved}
              download={`rak-${shelf.id}.jpg`}
              className="flex-1 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-center text-foreground"
            >
              Simpan gambar
            </a>
          </>
        ) : (
        <>
        <button
          type="button"
          onClick={() => setStrokes((s) => s.slice(0, -1))}
          disabled={strokes.length === 0}
          className="rounded-xl border border-white/30 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-30"
        >
          Undo
        </button>
        <span
          className="w-9 h-9 rounded-full border-2 border-white/60 shrink-0"
          style={{ background: colour }}
          aria-label="Warna pena"
        />
        <button
          type="button"
          onClick={share}
          disabled={strokes.length === 0 || busy}
          className="flex-1 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {busy ? "Menyiapkan…" : "Kirim ke WhatsApp"}
        </button>
        </>
        )}
      </div>
    </div>
  )
}
