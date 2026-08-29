/**
 * Money sitting on her account.
 *
 * One mark for one idea, wherever it shows up: the marker beside her handle on
 * the Invoice list, the banner that offers to spend it, and the button on a
 * refund that puts it there. Those are a state and an action, so they are
 * styled differently -- but they are the same money, and were drawn three
 * different ways: an emoji in two places and a bank card outline in the third.
 *
 * A stack of coins, after a long argument with everything else.
 *
 * 💰 went first: the only pictogram in an interface of line drawings, a
 * different picture on every platform, and unable to take the colour of the
 * thing it sits in. A wallet collapsed into a grey lump at 14px. A voucher
 * risked reading as a ticket in a shop that runs trips; a piggy bank lost its
 * ear and its legs at row size; a vault -- a ring centred in a rounded square
 * -- is the camera icon, whatever was meant by it; a money sack said money
 * plainly but is also how an order gets drawn in a shop, and outweighed its
 * neighbours besides. Two letters in a box said it without a picture at all,
 * and read as a label rather than a mark.
 *
 * Two tiers, not three: at 15px a third tier puts four horizontal lines inside
 * fifteen pixels and they close into a grey block.
 *
 * Drawn 2 to 22 rather than to the full box, which is the twenty units the bin
 * beside it measures -- the three marks on the row share a top and a bottom
 * line. The coordinates are the scaling already done, so the strokes stay the
 * weight its neighbours are drawn at.
 */
export function AccountCreditIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      <ellipse cx="12" cy="5.84" rx="9.59" ry="3.84" />
      <path d="M2.41 5.84v6.16c0 2.06 4.25 3.84 9.59 3.84s9.59-1.78 9.59-3.84V5.84" />
      <path d="M2.41 12v6.17c0 2.06 4.25 3.84 9.59 3.84s9.59-1.78 9.59-3.84V12" />
    </svg>
  )
}
