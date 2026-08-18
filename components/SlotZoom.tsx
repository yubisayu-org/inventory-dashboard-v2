"use client"

import { useState } from "react"

/** How much of the shelf's shorter side each step shows. */
const ZOOM_STEPS = [0.4, 0.28, 0.18, 0.12]

/**
 * A closer look at one slot.
 *
 * Zooming crops tighter rather than enlarging. A price tag is a handful of
 * pixels on a shelf photograph, so blowing up the same crop only makes it
 * blurrier — showing less of the shelf is the only thing that actually reveals
 * more of the label.
 */
export default function SlotZoom({ slotId, onClose }: { slotId: number; onClose: () => void }) {
  const [step, setStep] = useState(1)
  const share = ZOOM_STEPS[step]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      {/* The controls sit on the picture rather than under it: at the closest
          step the crop is small, and buttons in a row below it put the thing you
          are reading and the thing you are pressing a long way apart. */}
      {/* A fixed width, not the image's. A tighter crop is a smaller file — the
          route serves the pixels that exist rather than enlarging them — so
          sizing the panel to its content made the whole thing shrink as you
          looked closer, moving the buttons under your cursor. */}
      <div
        className="relative w-[min(90vw,640px)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- our own crop route. */}
        <img
          src={`/api/whatsapp/slots/${slotId}/thumb?share=${share}`}
          alt="Close-up of this item on the shelf"
          className="w-full rounded-xl bg-black"
        />

        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-2 right-2 w-9 h-9 rounded-full bg-black/60 text-white flex items-center justify-center"
        >
          <svg
            width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round"
          >
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full bg-black/60 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setStep((n) => Math.max(0, n - 1))}
            disabled={step === 0}
            aria-label="Show more of the shelf"
            className="w-8 h-8 rounded-full text-white flex items-center justify-center disabled:opacity-30"
          >
            <svg
              width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="20" y1="20" x2="16.65" y2="16.65" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          {/* How much closer than the widest step, rather than which step of
              four: "2.2×" says what you are looking at, "3/4" says where you are
              in a list nobody knew existed. */}
          <span className="text-[11px] text-white/80 tabular-nums">
            {(ZOOM_STEPS[0] / share).toFixed(1)}×
          </span>
          <button
            type="button"
            onClick={() => setStep((n) => Math.min(ZOOM_STEPS.length - 1, n + 1))}
            disabled={step === ZOOM_STEPS.length - 1}
            aria-label="Look closer"
            className="w-8 h-8 rounded-full text-white flex items-center justify-center disabled:opacity-30"
          >
            <svg
              width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="20" y1="20" x2="16.65" y2="16.65" />
              <line x1="8" y1="11" x2="14" y2="11" />
              <line x1="11" y1="8" x2="11" y2="14" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
