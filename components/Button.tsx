import type { ButtonHTMLAttributes, ReactNode } from "react"

type Variant = "primary" | "secondary" | "ghost" | "danger"
type Size = "md" | "sm"

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  children: ReactNode
}

/**
 * The button every screen should use.
 *
 * It exists because there was no such thing: primary buttons were written by
 * hand in roughly 130 places and had drifted into eight padding combinations,
 * four type sizes and four corner radii — three different heights could sit on
 * one toolbar. Nothing was wrong individually; they simply were not written
 * together.
 *
 * Sizes follow the radius rule the rest of the app now keeps: controls are
 * rounded-lg. `md` is the default and the one to reach for; `sm` is for a
 * control inside a dense row, not for saving space on a toolbar.
 */
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-white hover:bg-brand-dark",
  secondary: "bg-white border border-cream-border text-muted hover:border-brand hover:text-brand",
  // No chrome until touched — for an action that sits inside content.
  ghost: "text-muted hover:text-brand",
  danger: "bg-red-600 text-white hover:bg-red-700",
}

const SIZES: Record<Size, string> = {
  md: "px-4 py-2 text-sm",
  sm: "px-3 py-1.5 text-xs",
}

export default function Button({
  variant = "primary", size = "md", className = "", children, ...rest
}: Props) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold
        transition-colors disabled:opacity-50 disabled:cursor-not-allowed
        ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    >
      {children}
    </button>
  )
}
