/**
 * Money sitting on her account.
 *
 * One mark for one idea, wherever it shows up: the marker beside her handle on
 * the Invoice list, the banner that offers to spend it, and the button on a
 * refund that puts it there. Those are a state and an action, so they are
 * styled differently -- but they are the same money, and were drawn three
 * different ways: an emoji in two places and a bank card outline in the third.
 *
 * A vault, after four other answers.
 *
 * 💰 went first: the only pictogram in an interface of line drawings, a
 * different picture on every platform, and unable to take the colour of the
 * thing it sits in. A wallet replaced it and collapsed into a grey lump at
 * 14px. Coins read as money but as nothing more specific; a voucher risked
 * reading as a ticket in a shop that runs trips; a piggy bank lost its ear and
 * its legs at row size.
 *
 * A box with a dial says what this actually is: her money, kept somewhere, not
 * spent.
 *
 * The dial has to be a dial. A circle centred in a square is a camera lens --
 * that is the whole of the camera icon -- so the ring moves off centre, a seam
 * runs down the hinge side, and a stub of a handle sticks out where a hand
 * would take it. Nothing crosses the ring: a bar through a circle is a
 * prohibition sign and an X in one is a close button, and this is neither.
 */
export function AccountCreditIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 3v18" />
      <circle cx="13.5" cy="12" r="3.5" />
      <path d="M17.5 12h2" />
    </svg>
  )
}
