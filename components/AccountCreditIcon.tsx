/**
 * Money sitting on her account.
 *
 * One mark for one idea, wherever it shows up: the marker beside her handle on
 * the Invoice list, the banner that offers to spend it, and the button on a
 * refund that puts it there. Those are a state and an action, so they are
 * styled differently -- but they are the same money, and were drawn three
 * different ways: an emoji in two places and a bank card outline in the third.
 *
 * Not a drawing at all, in the end.
 *
 * Every pictogram tried here was read as something else at 15px. 💰 was the
 * only pictogram in an interface of line drawings, a different picture on
 * every platform, and could not take the colour of the thing it sat in. A
 * wallet collapsed into a grey lump. Coins said money but nothing more
 * specific; a voucher risked reading as a ticket in a shop that runs trips; a
 * piggy bank lost its ear and its legs at row size; a vault -- a ring in a
 * rounded square -- is the camera icon, whatever was meant by it.
 *
 * So the money is said rather than pictured. Two letters cannot be mistaken
 * for a lens or a ticket, and the badge is built like the count marker beside
 * it -- same border, same weight, a rounded box against its circle -- so the
 * row still reads as one set of marks.
 */
export function AccountCreditIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded-[4px] border-[1.25px] border-current font-bold leading-none tabular-nums ${className ?? ""}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.58) }}
    >
      Rp
    </span>
  )
}
