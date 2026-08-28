/**
 * Money sitting on her account.
 *
 * One mark for one idea, wherever it shows up: the marker beside her handle on
 * the Invoice list, the banner that offers to spend it, and the button on a
 * refund that puts it there. Those are a state and an action, so they are
 * styled differently -- but they are the same money, and were drawn three
 * different ways: an emoji in two places and a bank card outline in the third.
 *
 * A wallet rather than 💰: the emoji is the only pictogram in an interface of
 * line drawings, it renders as a different picture on every platform, and it
 * cannot take the colour of the thing it sits in.
 */
export function AccountCreditIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" />
      <path d="M16 12h.01" />
    </svg>
  )
}
