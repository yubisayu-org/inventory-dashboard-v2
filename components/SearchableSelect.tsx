"use client"

import { useState, useRef, useEffect, useMemo, useCallback, memo } from "react"

export interface SelectOption {
  value: string
  label: string
  /** Secondary text shown alongside the label (e.g. store name for items) */
  meta?: string
}

interface Props {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  /** Show a clear/reset option at the top of the list that sets value to "" */
  clearable?: boolean
  /** Allow typing a value that doesn't exist in options and committing it */
  allowNewValue?: boolean
}

export default function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Select...",
  disabled = false,
  clearable = false,
  allowNewValue = false,
}: Props) {
  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? (allowNewValue ? value : ""),
    [options, value, allowNewValue],
  )

  const [open, setOpen] = useState(false)
  const [inputValue, setInputValue] = useState(selectedLabel)
  const [highlightIdx, setHighlightIdx] = useState(-1)
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({})

  const inputRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Sync input display when selection changes externally (or on mount)
  useEffect(() => {
    if (!open) setInputValue(selectedLabel)
  }, [selectedLabel, open])

  // Stable refs so closeDropdown doesn't re-create on every keystroke
  const inputValueRef = useRef(inputValue)
  useEffect(() => { inputValueRef.current = inputValue }, [inputValue])

  const selectedLabelRef = useRef(selectedLabel)
  useEffect(() => { selectedLabelRef.current = selectedLabel }, [selectedLabel])

  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  const optionsRef = useRef(options)
  useEffect(() => { optionsRef.current = options }, [options])

  // ---------- Filtering ----------

  const LARGE_LIST = options.length > 100

  const [debouncedQuery, setDebouncedQuery] = useState("")
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(inputValue.trim().toLowerCase()), 200)
    return () => clearTimeout(id)
  }, [inputValue])

  const hasQuery = inputValue.trim().length > 0
  const filtered = useMemo(() => {
    if (debouncedQuery) return options.filter((o) => o.label.toLowerCase().includes(debouncedQuery))
    if (LARGE_LIST) return []
    return options
  }, [debouncedQuery, options, LARGE_LIST])

  useEffect(() => { setHighlightIdx((i) => (i === -1 ? i : -1)) }, [filtered])

  // ---------- Open / close ----------

  function positionPopup() {
    const rect = inputRef.current?.getBoundingClientRect()
    if (!rect) return
    const POPUP_HEIGHT = 260
    const spaceBelow = window.innerHeight - rect.bottom
    if (spaceBelow < POPUP_HEIGHT && rect.top > POPUP_HEIGHT) {
      setPopupStyle({ position: "fixed", bottom: window.innerHeight - rect.top + 4, left: rect.left, width: rect.width })
    } else {
      setPopupStyle({ position: "fixed", top: rect.bottom + 4, left: rect.left, width: rect.width })
    }
  }

  function openDropdown() {
    if (disabled || open) return
    positionPopup()
    setHighlightIdx(-1)
    setInputValue("")
    setOpen(true)
  }

  const closeDropdown = useCallback(() => {
    setOpen(false)
    if (allowNewValue) {
      const trimmed = inputValueRef.current.trim()
      if (trimmed) {
        // If it matches an existing option label (case-insensitive), select that option
        const match = optionsRef.current.find(
          (o) => o.label.toLowerCase() === trimmed.toLowerCase(),
        )
        if (match) {
          onChangeRef.current(match.value)
          setInputValue(match.label)
        } else {
          // Commit the raw typed text as a new value
          onChangeRef.current(trimmed)
          setInputValue(trimmed)
        }
      } else {
        setInputValue(selectedLabelRef.current)
      }
    } else {
      setInputValue(selectedLabelRef.current)
    }
  }, [allowNewValue])

  const selectOption = useCallback(
    (val: string) => {
      onChange(val)
      const label = options.find((o) => o.value === val)?.label ?? val
      setInputValue(label)
      setOpen(false)
      inputRef.current?.blur()
    },
    [onChange, options],
  )

  // Close on click outside (sole close mechanism, no blur handler)
  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Node
      if (
        !wrapperRef.current?.contains(target) &&
        !popupRef.current?.contains(target)
      ) {
        closeDropdown()
      }
    }
    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [open, closeDropdown])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { closeDropdown(); inputRef.current?.blur() }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [open, closeDropdown])

  // ---------- Input handlers ----------

  function handleFocus() {
    if (disabled) return
    openDropdown()
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value
    setInputValue(v)
    if (!open) openDropdown()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault()
        openDropdown()
      }
      return
    }

    const showClear = clearable && value && !hasQuery
    const clearOffset = showClear ? 1 : 0
    const showAddRow = allowNewValue && hasQuery && filtered.length === 0
    const total = filtered.length + clearOffset + (showAddRow ? 1 : 0)

    if (e.key === "ArrowDown") {
      e.preventDefault()
      setHighlightIdx((i) => (i + 1) % Math.max(total, 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setHighlightIdx((i) => (i - 1 + Math.max(total, 1)) % Math.max(total, 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (highlightIdx >= 0 && highlightIdx < total) {
        if (clearOffset && highlightIdx === 0) {
          selectOption("")
        } else {
          const opt = filtered[highlightIdx - clearOffset]
          if (opt) selectOption(opt.value)
          else if (showAddRow) {
            // "Add" row is highlighted
            selectOption(inputValue.trim())
          }
        }
      } else if (filtered.length === 1 && debouncedQuery) {
        selectOption(filtered[0].value)
      } else if (allowNewValue && inputValue.trim()) {
        // Commit free-typed value directly
        selectOption(inputValue.trim())
      }
    }
  }

  // ---------- Render ----------

  const showClearRow = clearable && value && !hasQuery
  const showAddRow = allowNewValue && hasQuery && filtered.length === 0

  return (
    <div ref={wrapperRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50 disabled:cursor-not-allowed pr-8"
      />
      <svg
        className={`absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none transition-transform ${open ? "rotate-180" : ""}`}
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fillRule="evenodd"
          d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
          clipRule="evenodd"
        />
      </svg>

      {open && (
        <div
          ref={popupRef}
          style={popupStyle}
          className="z-50 bg-white border border-cream-border rounded-lg shadow-lg overflow-hidden"
        >
          <ul className="max-h-56 overflow-y-auto">
            {showClearRow && (
              <OptionItem
                label={placeholder}
                highlighted={highlightIdx === 0}
                selected={false}
                onSelect={() => selectOption("")}
                className="text-gray-400"
              />
            )}
            {LARGE_LIST && !debouncedQuery ? (
              <li className="px-3 py-3 text-sm text-gray-400 text-center">
                {hasQuery ? "Searching…" : "Type to search..."}
              </li>
            ) : showAddRow ? (
              <li
                onMouseDown={(e) => { e.preventDefault(); selectOption(inputValue.trim()) }}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm cursor-pointer transition-colors ${
                  highlightIdx === 0 ? "bg-brand-light text-brand" : "text-foreground hover:bg-brand-light"
                }`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                <span>Add <span className="font-medium">&ldquo;{inputValue.trim()}&rdquo;</span></span>
              </li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-3 text-sm text-gray-400 text-center">
                No results
              </li>
            ) : (
              filtered.map((opt, i) => {
                const idx = i + (showClearRow ? 1 : 0)
                return (
                  <OptionItem
                    key={opt.value}
                    label={opt.label}
                    meta={opt.meta}
                    highlighted={highlightIdx === idx}
                    selected={value === opt.value}
                    onSelect={() => selectOption(opt.value)}
                  />
                )
              })
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

// ---------- OptionItem ----------

const OptionItem = memo(function OptionItem({
  label,
  meta,
  highlighted,
  selected,
  onSelect,
  className,
}: {
  label: string
  meta?: string
  highlighted: boolean
  selected: boolean
  onSelect: () => void
  className?: string
}) {
  const ref = useRef<HTMLLIElement>(null)

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest" })
  }, [highlighted])

  return (
    <li
      ref={ref}
      onMouseDown={(e) => {
        e.preventDefault()
        onSelect()
      }}
      className={`flex items-center justify-between px-3 py-2 text-sm cursor-pointer transition-colors ${
        highlighted
          ? "bg-brand-light text-brand"
          : selected
            ? "bg-brand-light text-brand font-medium"
            : "text-foreground hover:bg-brand-light"
      } ${className ?? ""}`}
    >
      <span>{label}</span>
      {meta && (
        <span className="ml-2 shrink-0 text-xs text-gray-400">{meta}</span>
      )}
    </li>
  )
})
