"use client"

import { useState, type ReactNode } from "react"

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
export default function SlotZoom({
  slotId, onClose, form, caption, info,
}: {
  slotId: number
  onClose: () => void
  /**
   * The naming fields, when the viewer is allowed to name.
   *
   * Passed in rather than built here: the valas being typed is the number
   * printed on the tag now filling the screen, and putting the two anywhere
   * else means remembering a number between taps. Absent — in the shop, or for
   * an admin — the viewer is only a viewer.
   */
  form?: ReactNode
  /** What is being named, so the sheet says which SKU it belongs to. */
  caption?: string
  /**
   * What was already typed, for a slot that has been named.
   *
   * The reason to zoom a named SKU is to check the tag against the valas — so
   * the answer belongs on the picture, not on the card behind it.
   */
  info?: string
}) {
  const [step, setStep] = useState(1)
  const [naming, setNaming] = useState(false)
  const share = ZOOM_STEPS[step]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center gap-4 bg-black/70 p-4"
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

        {info ? (
          <span className="absolute top-2 left-2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-white tabular-nums">
            {info}
          </span>
        ) : null}

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

        {/* Down the left edge rather than along the bottom.
            The naming sheet covers the bottom of the crop, and the whole point
            of naming here is to read the tag while typing it — so the zoom has
            to stay reachable with the fields open. A column at the edge is clear
            of both the sheet and the close button. */}
        <div className="absolute left-2 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1 rounded-full bg-black/60 px-1.5 py-2">
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

          <span className="text-[10px] text-white/80 tabular-nums">
            {(ZOOM_STEPS[0] / share).toFixed(1)}×
          </span>

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

          {form ? (
            <>
              <span className="h-px w-5 bg-white/25" />
              <button
                type="button"
                onClick={() => setNaming((open) => !open)}
                aria-label={naming ? "Hide the naming fields" : "Name this item"}
                className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  naming ? "bg-white text-foreground" : "text-white"
                }`}
              >
                <svg
                  width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                </svg>
              </button>
            </>
          ) : null}
        </div>

        {/* Over the bottom of the crop on a phone, so the tag stays visible
            above the field it is being typed into. */}
        {form && naming ? (
          <div className="absolute inset-x-0 bottom-0 max-h-[60%] overflow-auto rounded-b-xl bg-white p-3 lg:hidden">
            {/* Its own way out. The sheet covers the bottom of the crop, and the
                zoom bar — with the pencil that opened it — is under there. */}
            <div className="flex items-center gap-2 mb-2">
              {caption ? (
                <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500 truncate">
                  {caption}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => setNaming(false)}
                aria-label="Back to the picture"
                className="ml-auto shrink-0 rounded-full border border-cream-border px-2 py-1 text-[11px] font-bold text-gray-500"
              >
                Tutup
              </button>
            </div>
            {form}
          </div>
        ) : null}
      </div>

      {/* On a laptop nothing has to give way: the crop keeps its size and the
          fields sit beside it. Naming happens at a desk more often than not. */}
      {form && naming ? (
        <div className="hidden lg:block w-80 rounded-xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2 mb-2">
            {caption ? (
              <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500 truncate">
                {caption}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => setNaming(false)}
              aria-label="Close the naming fields"
              className="ml-auto shrink-0 rounded-full border border-cream-border px-2 py-1 text-[11px] font-bold text-gray-500"
            >
              Tutup
            </button>
          </div>
          {form}
        </div>
      ) : null}
    </div>
  )
}
