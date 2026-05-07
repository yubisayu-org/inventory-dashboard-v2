"use client"

import { useEffect, useState } from "react"

export function PaginationButton({ children, onClick, disabled = false, active = false }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`min-w-[2rem] h-8 px-2 text-xs rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${active ? "bg-brand text-white font-medium" : "border border-cream-border hover:bg-cream text-gray-600"}`}>
      {children}
    </button>
  )
}

export function PageJumpInput({ currentPage, totalPages, onJump }: {
  currentPage: number
  totalPages: number
  onJump: (page: number) => void
}) {
  const [value, setValue] = useState(String(currentPage))

  useEffect(() => { setValue(String(currentPage)) }, [currentPage])

  function commit() {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1) {
      setValue(String(currentPage))
      return
    }
    const clamped = Math.min(totalPages, Math.max(1, n))
    if (clamped !== currentPage) onJump(clamped)
    else setValue(String(currentPage))
  }

  return (
    <input
      type="number"
      min={1}
      max={totalPages}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur() }
      }}
      aria-label="Jump to page"
      className="w-12 text-center border border-cream-border rounded-md px-1 py-1 text-xs text-foreground bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  )
}

export function getPageNumbers(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: (number | "…")[] = [1]
  if (current > 3) pages.push("…")
  const start = Math.max(2, current - 1)
  const end   = Math.min(total - 1, current + 1)
  for (let p = start; p <= end; p++) pages.push(p)
  if (current < total - 2) pages.push("…")
  pages.push(total)
  return pages
}
