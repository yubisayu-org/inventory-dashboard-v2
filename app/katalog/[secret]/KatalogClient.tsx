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
  // Index rather than the shelf itself: the sheet walks the list without
  // closing, so it needs to know where it is in it.
  const [open, setOpen] = useState<number | null>(null)

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
        {shelves.map((shelf, index) => (
          <button
            key={shelf.id}
            type="button"
            onClick={() => setOpen(index)}
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

      {open !== null ? (
        <MarkSheet
          secret={secret}
          shelves={shelves}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </main>
  )
}

type Stroke = { x: number; y: number }[]

/**
 * Draw one shelf and its marks into a JPEG, away from the screen.
 *
 * The visible canvas holds whichever rack she is looking at, but she may have
 * circled things on five of them. Each one is redrawn here at the photograph's
 * own size — the image is already in the browser cache, so this costs no
 * bandwidth and no round trip.
 */
async function renderMarked(
  url: string,
  strokes: Stroke[],
  colour: string,
): Promise<Blob | null> {
  const image = new Image()
  image.crossOrigin = "anonymous"
  image.src = url
  await image.decode()

  const canvas = document.createElement("canvas")
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext("2d")
  if (!ctx) return null

  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
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

  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9))
}

/**
 * One shelf, with a finger to draw on it.
 *
 * The whole point is that what she sends back is the file she was shown, not a
 * photograph of her screen: the frames align exactly, which is the best input
 * the difference detector can get. So the export happens on the canvas at the
 * image's own size, and the sharing is left to the phone.
 */
function MarkSheet({
  secret, shelves, index, onIndex, onClose,
}: {
  secret: string
  shelves: Shelf[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const shelf = shelves[index]
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  // Kept per shelf, so walking to the next rack and back does not throw away
  // what she already circled. Cleared when the sheet closes, with the sheet.
  const [byShelf, setByShelf] = useState<Record<number, Stroke[]>>({})
  const strokes = byShelf[shelf.id] ?? []
  const setStrokes = useCallback(
    (update: (previous: Stroke[]) => Stroke[]) =>
      setByShelf((all) => ({ ...all, [shelf.id]: update(all[shelf.id] ?? []) })),
    [shelf.id],
  )
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<{ id: number; store: string; url: string }[] | null>(null)
  const drawing = useRef(false)
  // Fingers currently on the canvas, and whether the current one opened a
  // stroke — enough to tell a drag from the start of a pinch.
  const down = useRef(0)
  const started = useRef(false)
  /**
   * Zoom lives on the picture, not on the page.
   *
   * Browser pinch scales everything, so the pen colour, Undo and Kirim scaled
   * away with the shelf — and on iOS a fixed bar drifts about while the visual
   * viewport moves. Transforming the canvas instead leaves the controls where
   * her thumb expects them.
   */
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; k: number; x: number; y: number; cx: number; cy: number } | null>(null)

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

  // The load handler paints through this rather than waiting for an effect.
  // Setting canvas.width clears the bitmap, and on a cached image — going back
  // to a rack already seen — the ready flag goes false and true inside one
  // batch, so React sees no change, runs no effect, and the shelf stays blank.
  const repaintRef = useRef(repaint)
  useEffect(() => {
    repaintRef.current = repaint
  }, [repaint])

  // A new rack starts unzoomed; carrying a zoom across would land her in the
  // corner of a shelf she has not seen yet.
  useEffect(() => {
    setView({ k: 1, x: 0, y: 0 })
    pointers.current.clear()
    pinch.current = null
  }, [shelf.id])

  useEffect(() => {
    setReady(false)
    const image = new Image()
    // Same-origin today; explicit so moving the file to a bucket later does not
    // silently taint the canvas and break export.
    image.crossOrigin = "anonymous"
    image.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      // Assigning either dimension wipes the canvas, so the paint has to follow
      // in the same turn.
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      imageRef.current = image
      setReady(true)
      repaintRef.current()
    }
    image.src = `/api/public/katalog/${secret}/shelf/${shelf.id}`
  }, [secret, shelf.id])

  useEffect(repaint, [repaint, ready])

  const MAX_ZOOM = 6

  /** Distance and midpoint of the two fingers currently down. */
  function twoFingers() {
    const [a, b] = [...pointers.current.values()]
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    }
  }

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

  /** Every rack she has circled something on, in the order she saw them. */
  const marked = shelves.filter((each) => (byShelf[each.id] ?? []).length > 0)

  async function share() {
    setBusy(true)

    const files: File[] = []
    const previews: { id: number; store: string; url: string }[] = []
    for (const each of marked) {
      const blob = await renderMarked(
        `/api/public/katalog/${secret}/shelf/${each.id}`,
        byShelf[each.id] ?? [],
        penColour(each.hues),
      )
      if (!blob) continue
      files.push(new File([blob], `rak-${each.id}.jpg`, { type: "image/jpeg" }))
      previews.push({ id: each.id, store: each.store, url: URL.createObjectURL(blob) })
    }
    setBusy(false)
    if (files.length === 0) return

    // One share sheet for the lot: she picks the group once, and every marked
    // rack goes as its own photo, which is what the bot expects — one message
    // per shelf, each matching a shelf it stored.
    if (navigator.canShare?.({ files })) {
      try {
        await navigator.share({ files })
        previews.forEach((p) => URL.revokeObjectURL(p.url))
        return
      } catch {
        // Cancelled or refused; fall through to saving them by hand.
      }
    }
    setSaved(previews)
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/80 flex flex-col">
      {/* Both lines start at the same left edge by construction; the close
          button is pushed to the far side and takes no part in that. */}
      <div className="flex items-start gap-3 px-3 py-2 text-white shrink-0">
        <div className="min-w-0 flex-1">
          <span className="block text-sm font-semibold leading-6 truncate">
            {shelf.store}
            <span className="opacity-60 font-normal tabular-nums"> · {index + 1}/{shelves.length}</span>
          </span>
          {/* The header line is the running instruction: what to do now, which
              changes the moment the marks become pictures to save. */}
          <p className="text-[11px] opacity-70 leading-snug min-h-[2.4em]">
            {saved
              ? `Simpan ${saved.length === 1 ? "gambar" : `${saved.length} gambar`} ini satu per satu, lalu kirim ke grup`
              : "Lingkari atau centang barang yang diinginkan"}
          </p>
        </div>
        {/* Arrows rather than a swipe: a horizontal drag on the photograph is
            a pen stroke, and a gesture that means two things costs her a mark
            whenever it guesses wrong. */}
        <button
          type="button"
          onClick={() => onIndex(index - 1)}
          disabled={index === 0}
          className="text-lg leading-6 shrink-0 px-1.5 disabled:opacity-25"
          aria-label="Rak sebelumnya"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={() => onIndex(index + 1)}
          disabled={index >= shelves.length - 1}
          className="text-lg leading-6 shrink-0 px-1.5 disabled:opacity-25"
          aria-label="Rak berikutnya"
        >
          ›
        </button>
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
          <div className="flex flex-col items-center gap-3">
            {saved.map((item) => (
              <div key={item.id} className="relative w-full">
                {/* Sized exactly as the canvas is, so pressing Kirim does not
                    appear to nudge the shelf down the screen: the picture is
                    the same picture, in the same place. */}
                {/* eslint-disable-next-line @next/next/no-img-element -- a blob we just made. */}
                <img
                  src={item.url}
                  alt={item.store}
                  className="w-full h-auto rounded-lg"
                />
                {/* Over the picture it belongs to, so three shelves cannot end
                    up saved in the wrong order. One control per picture because
                    iOS saves a single file per gesture whatever the page does. */}
                <a
                  href={item.url}
                  download={`rak-${item.id}.jpg`}
                  aria-label={`Simpan ${item.store}`}
                  className="absolute bottom-3 right-3 w-12 h-12 rounded-full bg-white/90 text-foreground flex items-center justify-center shadow-lg"
                >
                  <svg
                    width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </a>
              </div>
            ))}
          </div>
        ) : null}

        {/* The canvas is transformed, not the page: pinching scales the shelf
            while Undo, the pen and Kirim stay exactly where they were. The
            wrapper clips, so a zoomed shelf cannot push the layout around. */}
        <div className={`w-full overflow-hidden rounded-lg ${saved ? "hidden" : ""}`}>
          <canvas
            ref={canvasRef}
            onPointerDown={(e) => {
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
              down.current = pointers.current.size

              // A second finger means she is reading a price tag, not drawing.
              // Whatever the first began is discarded, so zooming never leaves a
              // stray line across the shelf.
              if (down.current > 1) {
                drawing.current = false
                if (started.current) setStrokes((all) => all.slice(0, -1))
                started.current = false
                if (down.current === 2) {
                  const { dist, cx, cy } = twoFingers()
                  pinch.current = { dist, k: view.k, x: view.x, y: view.y, cx, cy }
                }
                return
              }

              drawing.current = true
              started.current = true
              const p = pointFrom(e)
              setStrokes((all) => [...all, [p]])
            }}
            onPointerMove={(e) => {
              if (!pointers.current.has(e.pointerId)) return
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

              if (pointers.current.size >= 2 && pinch.current) {
                const { dist, cx, cy } = twoFingers()
                const from = pinch.current
                const k = Math.min(MAX_ZOOM, Math.max(1, (from.k * dist) / from.dist))
                // Keep whatever sits between her fingers under her fingers, and
                // follow them as they travel: pinch and pan in one gesture.
                setView({
                  k,
                  x: cx - ((from.cx - from.x) / from.k) * k,
                  y: cy - ((from.cy - from.y) / from.k) * k,
                })
                return
              }

              if (!drawing.current) return
              const p = pointFrom(e)
              setStrokes((all) => {
                const next = [...all]
                next[next.length - 1] = [...next[next.length - 1], p]
                return next
              })
            }}
            onPointerUp={(e) => {
              pointers.current.delete(e.pointerId)
              down.current = pointers.current.size
              if (pointers.current.size < 2) pinch.current = null
              drawing.current = false
              started.current = false
            }}
            onPointerCancel={(e) => {
              pointers.current.delete(e.pointerId)
              down.current = pointers.current.size
              pinch.current = null
              drawing.current = false
              started.current = false
            }}
            // Every gesture is handled here now, so the browser is told to keep
            // its hands off: its own pinch would scale the controls with it.
            style={{
              touchAction: "none",
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
              transformOrigin: "0 0",
            }}
            className="w-full h-auto select-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 p-3 shrink-0">
        {saved ? (
          <button
            type="button"
            onClick={() => {
              // The blobs stay alive for the tab's lifetime otherwise, and a
              // customer marking rack after rack would accumulate megabytes.
              saved.forEach((item) => URL.revokeObjectURL(item.url))
              setSaved(null)
            }}
            className="flex-1 rounded-xl border border-white/30 px-4 py-2.5 text-sm font-semibold text-white"
          >
            Kembali
          </button>
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
        {view.k > 1 ? (
          <button
            type="button"
            onClick={() => setView({ k: 1, x: 0, y: 0 })}
            className="rounded-xl border border-white/30 px-3 py-2.5 text-xs font-bold text-white tabular-nums shrink-0"
          >
            {view.k.toFixed(1)}× ✕
          </button>
        ) : (
          <span
            className="w-9 h-9 rounded-full border-2 border-white/60 shrink-0"
            style={{ background: colour }}
            aria-label="Warna pena"
          />
        )}
        <button
          type="button"
          onClick={share}
          disabled={marked.length === 0 || busy}
          className="flex-1 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {busy
            ? "Menyiapkan…"
            : marked.length > 1
              ? `Kirim ${marked.length} rak ke WhatsApp`
              : "Kirim ke WhatsApp"}
        </button>
        </>
        )}
      </div>
    </div>
  )
}
