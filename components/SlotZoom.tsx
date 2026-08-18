"use client"

import { useState, type ReactNode } from "react"

/** How much of the shelf's shorter side each step shows. */
const ZOOM_STEPS = [0.4, 0.28, 0.18, 0.12]

/**
 * A closer look at one slot, and the fields that name it.
 *
 * Zooming crops tighter rather than enlarging. A price tag is a handful of
 * pixels on a shelf photograph, so blowing up the same crop only makes it
 * blurrier — showing less of the shelf is the only thing that actually reveals
 * more of the label.
 */
export default function SlotZoom({
  slotId, onClose, form, caption,
}: {
  slotId: number
  onClose: () => void
  /**
   * The naming fields, when the viewer is allowed to name.
   *
   * Passed in rather than built here: the valas being typed is the number
   * printed on the tag now filling the screen, and putting the two anywhere
   * else means remembering a number between taps.
   */
  form?: ReactNode
  /** What is on screen — the name it was given, and what it sells for. */
  caption?: string
}) {
  const [step, setStep] = useState(1)
  const share = ZOOM_STEPS[step]

  const glyph = "w-8 h-8 rounded-full text-white flex items-center justify-center disabled:opacity-30"

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col lg:flex-row items-center justify-center lg:gap-3 overflow-auto bg-black/70 p-4"
      onClick={onClose}
    >
      {/* A fixed width, not the image's. A tighter crop is a smaller file — the
          route serves the pixels that exist rather than enlarging them — so
          sizing the box to its content made the whole thing shrink as you looked
          closer, moving the buttons out from under the cursor. */}
      <div
        className="relative w-[min(90vw,640px)] shrink-0"
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
          className="absolute top-2 right-2 w-9 h-9 rounded-full bg-black/55 text-white flex items-center justify-center backdrop-blur-sm"
        >
          <svg
            width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round"
          >
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        {/* Top left, in a column: clear of the fields floating at the bottom and
            of the close button opposite, so nothing has to move when either
            appears. */}
        <div className="absolute left-2 top-2 flex flex-col items-center gap-1 rounded-full bg-black/55 px-1.5 py-2 backdrop-blur-sm">
          <button
            type="button"
            onClick={() => setStep((n) => Math.min(ZOOM_STEPS.length - 1, n + 1))}
            disabled={step === ZOOM_STEPS.length - 1}
            aria-label="Look closer"
            className={glyph}
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

          <span className="text-[10px] text-white/80 tabular-nums">
            {(ZOOM_STEPS[0] / share).toFixed(1)}×
          </span>

          <button
            type="button"
            onClick={() => setStep((n) => Math.max(0, n - 1))}
            disabled={step === 0}
            aria-label="Show more of the shelf"
            className={glyph}
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
        </div>

        {/* Floating over the crop in the same glass as the buttons, so the
            photograph runs edge to edge and the screen has one material.
            The fields themselves stay on white inside it: a price tag and a
            weight are numbers that must not be mistyped, and a text field on a
            shelf photograph is the busiest background there is. */}
        {form ? (
          <div className="absolute inset-x-2 bottom-2 rounded-xl bg-black/45 p-2 backdrop-blur-md lg:hidden">
            {caption ? (
              <p className="px-1 pb-1.5 text-[11px] font-bold uppercase tracking-wide text-white/85 truncate">
                {caption}
              </p>
            ) : null}
            <div className="rounded-lg bg-white p-2">{form}</div>
          </div>
        ) : null}
      </div>

      {/* On a laptop nothing has to give way: the crop keeps its size and the
          fields sit beside it. Naming happens at a desk more often than not. */}
      {form ? (
        <div
          className="hidden lg:block w-80 rounded-xl bg-white p-4"
          onClick={(e) => e.stopPropagation()}
        >
          {caption ? (
            <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500 truncate mb-2">
              {caption}
            </p>
          ) : null}
          {form}
        </div>
      ) : null}
    </div>
  )
}
