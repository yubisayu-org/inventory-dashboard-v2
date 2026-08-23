import type { ReactNode } from "react"

interface Props {
  title: string
  subtitle: ReactNode
  /**
   * A control that belongs to the page rather than to its content — a back
   * arrow, say. Sits before the title, at its baseline.
   */
  before?: ReactNode
  /**
   * A control that acts on the whole page: a pricing selector, an export.
   * Pushed to the far right and kept clear of a long title.
   */
  actions?: ReactNode
  /**
   * Tighten the block for a screen you arrive at from another, rather than
   * one you navigate to. The type stays the same size; only the space below
   * it closes up.
   */
  compact?: boolean
}

/**
 * The heading every dashboard screen opens with.
 *
 * Worth using even where a screen wants extras: before this took `before` and
 * `actions`, the shelf page wrote its own — 20px uppercase against this one's
 * 24px sentence case — so walking from Group Order into a shelf visibly
 * shrank the heading and changed its case. That was the only such jump in 47
 * screens, and it existed because there was nowhere to put a back arrow.
 */
export default function PageHeader({ title, subtitle, before, actions, compact }: Props) {
  return (
    <div className={`flex items-start gap-3 ${compact ? "mb-3" : "mb-6"}`}>
      {before ? <div className="shrink-0 pt-1">{before}</div> : null}
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-bold text-foreground truncate">{title}</h1>
        <div className="text-sm text-muted mt-0.5">{subtitle}</div>
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  )
}
