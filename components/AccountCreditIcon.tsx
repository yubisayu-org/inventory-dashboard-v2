/**
 * Money sitting on her account.
 *
 * One mark for one idea, wherever it shows up: the marker beside her handle on
 * the Invoice list, the banner that offers to spend it, and the button on a
 * refund that puts it there. Those are a state and an action, so they are
 * styled differently -- but they are the same money, and were drawn three
 * different ways: an emoji in two places and a bank card outline in the third.
 *
 * Two coins rather than a wallet, and neither is 💰.
 *
 * The emoji went first: it was the only pictogram in an interface of line
 * drawings, it renders as a different picture on every platform, and it cannot
 * take the colour of the thing it sits in. The wallet that replaced it was the
 * right idea at the wrong size -- at 14px in a row of marks its clasp and fold
 * collapse into a grey lump.
 *
 * Two overlapping discs survive being small, and read as money before they
 * read as anything else, which is what this has to say in both its jobs: money
 * she is holding, and money about to be moved onto another order.
 */
export function AccountCreditIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      <circle cx="9" cy="9" r="6" />
      <path d="M15.5 5.6a6 6 0 0 1 0 12.8" />
    </svg>
  )
}
