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
      <header className="flex items-stretch gap-3 px-4 py-3 border-b border-cream-border bg-white sticky top-0 z-10">
        {/* The same mark the dashboard uses, round here: this is the one screen
            a customer sees, so it should say whose shop it is before it says
            anything else. No logo file exists yet — when one does, it replaces
            the letter and nothing else changes. */}
        {/* Stretched to the two lines beside it rather than given a size of its
            own, so it stays exactly as tall as the title and event line
            whatever the type does. */}
        <span className="self-stretch aspect-square shrink-0 rounded-full bg-brand flex items-center justify-center">
          <span className="text-white text-base font-bold">Y</span>
        </span>
        <div className="min-w-0">
          <h1 className="text-base font-bold text-foreground">Group Catalogue</h1>
          <p className="text-xs text-gray-500 tabular-nums truncate">
            {event} · {shelves.length} SHELVES
          </p>
        </div>
      </header>

      {/* Same horizontal padding as the header and the hint below it, so the
          first rack lines up with the words above it. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 px-4 py-3">
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

      <p className="px-4 pb-8 text-[11px] text-gray-500 leading-snug">
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
  const [view, setView] = useState({ k: 1, cx: 0.5, cy: 0.5 })
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  /** Screen midpoint the current pinch started from. */
  const pinchMid = useRef<{ x: number; y: number } | null>(null)
  /** When and where the last tap landed, for spotting a double one. */
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null)
  /**
   * Points in the stroke being drawn right now.
   *
   * Counted here rather than read back from state: a setStrokes updater runs
   * when React gets round to it, so asking it "was that a tap?" during the
   * pointerup handler answered about the previous render and swallowed every
   * double tap.
   */
  const strokePoints = useRef(0)
  const pinch = useRef<{ dist: number; k: number; cx: number; cy: number } | null>(null)

  const colour = penColour(shelf.hues)

  /**
   * Draw the part of the shelf she is looking at, at the canvas's own
   * resolution.
   *
   * Zoom used to be a CSS transform on the element, which magnifies the
   * rasterised canvas — about 380 device-independent pixels wide — rather than
   * the 2250 pixels the file actually holds. A price tag went soft at exactly
   * the moment she zoomed in to read it. Redrawing the source region instead
   * uses the pixels that are there.
   */
  const repaint = useCallback(() => {
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!canvas || !image) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const iw = image.naturalWidth
    const ih = image.naturalHeight
    // The window into the photograph: the whole of it at 1×, a k-th of it at k.
    const vw = iw / view.k
    const vh = ih / view.k
    const sx = Math.min(iw - vw, Math.max(0, view.cx * iw - vw / 2))
    const sy = Math.min(ih - vh, Math.max(0, view.cy * ih - vh / 2))

    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(image, sx, sy, vw, vh, 0, 0, canvas.width, canvas.height)

    // Strokes are kept in the photograph's coordinates so they stay put under
    // zoom and export at full size; only the drawing of them is scaled.
    const scale = canvas.width / vw
    ctx.lineWidth = Math.max(6, iw / 150) * scale
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.strokeStyle = colour
    for (const stroke of strokes) {
      if (stroke.length < 2) continue
      ctx.beginPath()
      ctx.moveTo((stroke[0].x - sx) * scale, (stroke[0].y - sy) * scale)
      for (const point of stroke.slice(1)) {
        ctx.lineTo((point.x - sx) * scale, (point.y - sy) * scale)
      }
      ctx.stroke()
    }
  }, [strokes, colour, view])

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
    setView({ k: 1, cx: 0.5, cy: 0.5 })
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
      // Sized to the space it occupies, times the device's pixel ratio — the
      // photograph itself is far larger and is sampled into this. Assigning
      // either dimension wipes the bitmap, so the paint follows in the same
      // turn.
      const css = canvas.clientWidth || canvas.parentElement?.clientWidth || 360
      const dpr = Math.min(3, window.devicePixelRatio || 1)
      canvas.width = Math.round(css * dpr)
      canvas.height = Math.round(css * dpr * (image.naturalHeight / image.naturalWidth))
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

  /** Where a touch lands in the photograph, whatever the zoom. */
  function pointFrom(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!canvas || !image) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const iw = image.naturalWidth
    const ih = image.naturalHeight
    const vw = iw / view.k
    const vh = ih / view.k
    const sx = Math.min(iw - vw, Math.max(0, view.cx * iw - vw / 2))
    const sy = Math.min(ih - vh, Math.max(0, view.cy * ih - vh / 2))
    return {
      x: sx + ((e.clientX - rect.left) / rect.width) * vw,
      y: sy + ((e.clientY - rect.top) / rect.height) * vh,
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
        <div className={`relative w-full overflow-hidden rounded-lg ${saved ? "hidden" : ""}`}>
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
                  pinch.current = { dist, k: view.k, cx: view.cx, cy: view.cy }
                  pinchMid.current = { x: cx, y: cy }
                }
                return
              }

              drawing.current = true
              started.current = true
              strokePoints.current = 1
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

                // Pan by where the fingers have travelled since the pinch
                // began, in fractions of the visible window — so the shelf
                // follows the hand rather than the hand chasing the shelf.
                const canvas = canvasRef.current
                const rect = canvas?.getBoundingClientRect()
                const startMid = pinchMid.current
                const dx = rect && startMid ? (cx - startMid.x) / rect.width / k : 0
                const dy = rect && startMid ? (cy - startMid.y) / rect.height / k : 0
                const half = 1 / (2 * k)
                setView({
                  k,
                  cx: Math.min(1 - half, Math.max(half, from.cx - dx)),
                  cy: Math.min(1 - half, Math.max(half, from.cy - dy)),
                })
                return
              }

              if (!drawing.current) return
              strokePoints.current += 1
              const p = pointFrom(e)
              setStrokes((all) => {
                const next = [...all]
                next[next.length - 1] = [...next[next.length - 1], p]
                return next
              })
            }}
            onPointerUp={(e) => {
              const wasDrawing = drawing.current && started.current
              pointers.current.delete(e.pointerId)
              down.current = pointers.current.size
              if (pointers.current.size < 2) {
                pinch.current = null
                pinchMid.current = null
              }
              drawing.current = false
              started.current = false
              if (!wasDrawing) return

              // A tap leaves a one-point stroke, which draws nothing but would
              // count the rack as marked and send it. Dropped here, which also
              // frees the tap to mean something else.
              const wasTap = strokePoints.current < 3
              strokePoints.current = 0
              if (!wasTap) return
              setStrokes((all) => {
                const last = all[all.length - 1]
                return last && last.length < 3 ? all.slice(0, -1) : all
              })

              // Two taps in the same spot: zoom to it, or back out if already
              // in. The habit comes from Photos and Maps, so it needs no
              // explaining — the dots are for everyone who never tries it.
              const now = Date.now()
              const previous = lastTap.current
              const near =
                previous &&
                now - previous.at < 320 &&
                Math.hypot(e.clientX - previous.x, e.clientY - previous.y) < 30

              if (near) {
                lastTap.current = null
                const image = imageRef.current
                if (!image) return
                if (view.k > 1) {
                  setView({ k: 1, cx: 0.5, cy: 0.5 })
                  return
                }
                const p = pointFrom(e)
                const k = 3
                const half = 1 / (2 * k)
                setView({
                  k,
                  cx: Math.min(1 - half, Math.max(half, p.x / image.naturalWidth)),
                  cy: Math.min(1 - half, Math.max(half, p.y / image.naturalHeight)),
                })
                return
              }
              lastTap.current = { at: now, x: e.clientX, y: e.clientY }
            }}
            onPointerCancel={(e) => {
              pointers.current.delete(e.pointerId)
              down.current = pointers.current.size
              pinch.current = null
              pinchMid.current = null
              drawing.current = false
              started.current = false
            }}
            // Every gesture is handled here now, so the browser is told to keep
            // its hands off: its own pinch would scale the controls with it.
            // No CSS transform: zoom is drawn, not scaled, so the pixels come
            // from the photograph rather than from a magnified screenshot of it.
            style={{ touchAction: "none" }}
            className="w-full h-auto select-none"
          />

          {/* The gesture, shown rather than named: two fingertips closing and
              opening on a diagonal. A still picture of a pinch reads as two
              dots; the movement is the part that means something. It stops
              being drawn the moment she zooms, and honours a reduced-motion
              preference by simply holding still. */}
          {/* On the picture rather than in the bar: it acts on the shelf, and
              the bar is for the pen. Top right keeps it clear of the pinch hint
              in the opposite corner. */}
          {view.k > 1 ? (
            <button
              type="button"
              onClick={() => setView({ k: 1, cx: 0.5, cy: 0.5 })}
              className="absolute top-2 right-2 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-bold text-white tabular-nums"
            >
              {view.k.toFixed(1)}× ✕
            </button>
          ) : null}

          {view.k === 1 ? (
            <span
              className="katalog-hint pointer-events-none absolute bottom-2 left-2 w-10 h-10 rounded-full bg-black/55 flex items-center justify-center"
              aria-label="Cubit untuk memperbesar"
            >
              <span className="relative block w-6 h-6">
                <span className="katalog-pinch katalog-pinch-a absolute w-2 h-2 rounded-full bg-white" />
                <span className="katalog-pinch katalog-pinch-b absolute w-2 h-2 rounded-full bg-white" />
              </span>
              <style>{`
                /* Plays twice and stops, then the badge fades out: a loop
                   over a dense rack pulls the eye away from the products. */
                .katalog-pinch { animation: katalog-pinch 1.4s ease-in-out 2 both; }
                .katalog-pinch-a { top: 2px; left: 2px; }
                .katalog-pinch-b { bottom: 2px; right: 2px; animation-name: katalog-pinch-rev; }
                @keyframes katalog-pinch {
                  0%, 100% { transform: translate(0, 0); }
                  50% { transform: translate(6px, 6px); }
                }
                @keyframes katalog-pinch-rev {
                  0%, 100% { transform: translate(0, 0); }
                  50% { transform: translate(-6px, -6px); }
                }
                .katalog-hint { animation: katalog-hint-out 0.6s ease-in 3.2s both; }
                @keyframes katalog-hint-out {
                  to { opacity: 0; }
                }
                @media (prefers-reduced-motion: reduce) {
                  .katalog-pinch { animation: none; }
                  .katalog-hint { animation-delay: 4s; }
                }
              `}</style>
            </span>
          ) : null}
        </div>
      </div>

      {/* One height for every control: padding plus a border made Undo two
          pixels taller than Kirim, and the pen swatch six shorter than both. */}
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
            className="h-11 flex-1 rounded-xl border border-white/30 px-4 text-sm font-semibold text-white"
          >
            Kembali
          </button>
        ) : (
        <>
        <button
          type="button"
          onClick={() => setStrokes((s) => s.slice(0, -1))}
          disabled={strokes.length === 0}
          // Disabled fades the label, not the box: opacity on the whole button
          // dimmed its border too, so beside the pencil — same radius, same
          // border, never disabled — the two looked drawn with different pens.
          className="h-11 rounded-xl border border-white/30 px-4 text-sm font-semibold text-white disabled:text-white/35"
        >
          Undo
        </button>
        {/* The pen stays on show at every zoom level. It was swapped for the
            reset button while zoomed, which removed the only sign that she can
            still draw at exactly the moment she is closest to the item and most
            likely to want to. */}
        {/* Shaped and bordered like Undo beside it, so the row reads as one set
            of controls. The pencil is stroked in this shelf's colour, so the
            swatch shows what she will draw with rather than merely being a
            coloured thing. */}
        <span
          className="w-11 h-11 rounded-xl border border-white/30 shrink-0 flex items-center justify-center"
          aria-label="Warna pensil untuk rak ini"
        >
          <svg
            width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={colour}
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
          </svg>
        </span>

        <button
          type="button"
          onClick={share}
          disabled={marked.length === 0 || busy}
          className="h-11 flex-1 rounded-xl bg-brand px-4 text-sm font-bold text-white disabled:opacity-40"
        >
          {busy
            ? "Menyiapkan…"
            : marked.length > 1
              ? `Kirim ${marked.length} rak ke WhatsApp Group`
              : "Kirim ke WhatsApp Group"}
        </button>
        </>
        )}
      </div>
    </div>
  )
}
