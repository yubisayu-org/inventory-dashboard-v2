"use client"

import { useEffect, useMemo, useRef, useState } from "react"

/**
 * One field for either a single day or a range.
 *
 * Two native date inputs cannot express "12 – 14 Aug" in one control, and a
 * report is asked for either way round: one day when a parcel landed, a span
 * when a week is being reconciled. So this is a calendar of our own — click a
 * day for a single date, click a second to close a range, click again to start
 * over.
 *
 * Dates are plain YYYY-MM-DD strings throughout. Nothing here constructs a
 * Date from one without pinning it to local noon: `new Date("2026-08-12")` is
 * midnight UTC, which in Jakarta is already the 12th but in New York is still
 * the 11th, and a report that quietly shifts a day is worse than no report.
 */

export interface DateRange {
  from: string
  to: string
}

const DAY_MS = 86_400_000
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"]
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
// Monday first: a jastip week is counted from Monday, and the shipping day is
// usually at the end of it.
const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"]

/** Local noon, so a date never crosses a day boundary through a timezone. */
function atNoon(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(y, m - 1, d, 12)
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function label(from: string, to: string): string {
  if (!from && !to) return ""
  const a = atNoon(from || to)
  if (!to || from === to) return `${a.getDate()} ${SHORT[a.getMonth()]} ${a.getFullYear()}`
  const b = atNoon(to)
  // Drop the repeated month and year: "12 – 14 Aug 2026" reads faster than
  // saying August twice.
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
    return `${a.getDate()} – ${b.getDate()} ${SHORT[a.getMonth()]} ${a.getFullYear()}`
  }
  if (a.getFullYear() === b.getFullYear()) {
    return `${a.getDate()} ${SHORT[a.getMonth()]} – ${b.getDate()} ${SHORT[b.getMonth()]} ${a.getFullYear()}`
  }
  return `${a.getDate()} ${SHORT[a.getMonth()]} ${a.getFullYear()} – ${b.getDate()} ${SHORT[b.getMonth()]} ${b.getFullYear()}`
}

export default function DateRangeField({
  value, onChange, max, placeholder = "All dates", className = "", inline = false,
}: {
  value: DateRange
  onChange: (next: DateRange) => void
  /** Latest selectable day, YYYY-MM-DD. Usually today. */
  max?: string
  placeholder?: string
  className?: string
  /**
   * Show the calendar itself, with no field to open it.
   *
   * For somewhere that is already a popover — a column filter, say — where a
   * button opening a second popover would be a door behind a door, and the
   * calendar would have to escape a container that clips it.
   */
  inline?: boolean
}) {
  const [open, setOpen] = useState(inline)
  // Which day the pointer is over while a range is half-made, so the days
  // between light up before the second click commits them.
  const [hover, setHover] = useState("")
  const [month, setMonth] = useState(() => atNoon(value.from || max || toISO(new Date())))
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || inline) return
    function away(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    function esc(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", away)
    document.addEventListener("keydown", esc)
    return () => {
      document.removeEventListener("mousedown", away)
      document.removeEventListener("keydown", esc)
    }
  }, [open, inline])

  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1, 12)
    // Monday = 0
    const lead = (first.getDay() + 6) % 7
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
    const cells: (string | null)[] = Array(lead).fill(null)
    for (let d = 1; d <= count; d++) cells.push(toISO(new Date(month.getFullYear(), month.getMonth(), d, 12)))
    return cells
  }, [month])

  const { from, to } = value
  // While one end is chosen and the pointer is elsewhere, preview the span.
  const previewTo = from && !to && hover ? hover : to
  const [lo, hi] = from && previewTo && from > previewTo ? [previewTo, from] : [from, previewTo]

  function pick(iso: string) {
    if (max && iso > max) return
    // No end yet → this closes the range. Both ends set → start again, which is
    // what a third click means every time.
    if (from && !to) {
      onChange(iso < from ? { from: iso, to: from } : { from, to: iso })
      setHover("")
      if (!inline) setOpen(false)
      return
    }
    onChange({ from: iso, to: "" })
    setHover("")
  }

  const text = label(from, to)

  const calendar = (
    <div className={inline ? "" : "absolute z-30 mt-1 w-[17rem] rounded-xl border border-cream-border bg-white p-3 shadow-lg"}>
      <div className="flex items-center justify-between mb-2">
        <button
          type="button" aria-label="Previous month"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1, 12))}
          className="w-7 h-7 rounded-lg text-muted hover:text-brand hover:bg-surface-sunken flex items-center justify-center"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <span className="text-sm font-semibold">{MONTHS[month.getMonth()]} {month.getFullYear()}</span>
        <button
          type="button" aria-label="Next month"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1, 12))}
          className="w-7 h-7 rounded-lg text-muted hover:text-brand hover:bg-surface-sunken flex items-center justify-center"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="m9 18 6-6-6-6" /></svg>
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {WEEKDAYS.map((d, i) => (
          <span key={i} className="text-[10px] text-faint text-center py-1">{d}</span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5" onMouseLeave={() => setHover("")}>
        {days.map((iso, i) => {
          if (!iso) return <span key={`pad-${i}`} />
          const disabled = Boolean(max && iso > max)
          const isEnd = iso === from || iso === to
          const inside = Boolean(lo && hi && iso > lo && iso < hi)
          return (
            <button
              key={iso}
              type="button"
              disabled={disabled}
              onMouseEnter={() => setHover(iso)}
              onClick={() => pick(iso)}
              className={`h-8 rounded-lg text-xs tabular-nums transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                isEnd ? "bg-brand text-white font-semibold"
                  : inside ? "bg-brand-light text-brand"
                    : "hover:bg-surface-sunken text-muted-strong"
              }`}
            >
              {atNoon(iso).getDate()}
            </button>
          )
        })}
      </div>

      <p className="mt-2 text-[11px] text-faint">
        {from && !to ? "Pick a second day for a range, or the same day twice." : "One day, or click two for a range."}
      </p>
    </div>
  )

  // Inside something that is already a popover, the calendar IS the control —
  // a button opening a second layer would be a door behind a door.
  if (inline) {
    return (
      <div className={className}>
        {text && (
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-medium text-foreground">{text}</span>
            <button
              type="button"
              onClick={() => onChange({ from: "", to: "" })}
              className="ml-auto text-xs text-faint hover:text-brand transition-colors"
            >
              Clear
            </button>
          </div>
        )}
        {calendar}
      </div>
    )
  }

  return (
    <div ref={box} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full h-[38px] flex items-center gap-2 rounded-lg border border-cream-border bg-white px-3 text-sm text-left transition-colors hover:border-brand"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-faint">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        <span className={`truncate ${text ? "text-foreground" : "text-faint"}`}>{text || placeholder}</span>
        {text && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear dates"
            onClick={(e) => { e.stopPropagation(); onChange({ from: "", to: "" }) }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onChange({ from: "", to: "" }) } }}
            className="ml-auto shrink-0 text-faint hover:text-brand"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </span>
        )}
      </button>
      {open && calendar}
    </div>
  )
}
