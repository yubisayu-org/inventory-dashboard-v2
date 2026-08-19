import sql from "@/lib/db-pool"
import { normalizeSize } from "@/lib/claims/size"
import { recluster } from "./ingest"

/** How the swap reads in the note, and how it is recognised as already there. */
const ARROW = "→ Size"

/**
 * Move one claim onto a different size.
 *
 * The customer asked for 95, the shelf has 100, and somebody with the authority
 * to say so has agreed the swap — the owner reading her own written fallback, or
 * the customer answering an offer with 👍. This is what that agreement does.
 *
 * Two things change and neither destroys what she wrote. The agreed size goes in
 * its own column, because the note is copied onto her order and appears on her
 * invoice; and the note gains "→ Size 100" on the end, because an invoice line
 * reading only "Size 95" beside a size 100 garment is a complaint waiting to
 * happen. The column is what the code acts on, the note is what people read.
 *
 * Refused once the slot is named: the product carries the size in its name and
 * the orders are placed, so a swap there is a different, larger correction than
 * this one.
 */
export async function swapClaimSize(claimId: number, size: string): Promise<void> {
  const agreed = normalizeSize(size)
  if (!agreed) throw new Error(`"${size}" is not a size`)

  const [claim] = await sql`
    SELECT c.id, c.post_id, c.note, c.size, s.product_id
    FROM wa_claims c LEFT JOIN wa_slots s ON s.id = c.slot_id
    WHERE c.id = ${claimId}
  `
  if (!claim) throw new Error(`no such claim: ${claimId}`)
  if (claim.product_id !== null) {
    throw new Error(`claim ${claimId} is on a slot that has already been named`)
  }

  const note = claim.note as string
  // Swapped twice — 95 to 100 to 110 — appends once more rather than stacking a
  // second arrow onto the first, so the note stays "asked X, got Y".
  const base = note.includes(ARROW) ? note.slice(0, note.indexOf(ARROW)).trimEnd() : note
  const rewritten = base ? `${base} ${ARROW} ${agreed}` : `${ARROW} ${agreed}`

  await sql`
    UPDATE wa_claims SET size = ${agreed}, note = ${rewritten}, updated_at = NOW()
    WHERE id = ${claimId}
  `

  // The claim now belongs to a different size, which is a different slot. That
  // slot may not exist yet — nobody else asked for a 100 — and reclustering is
  // what creates it, on the same peg, from the claim's own position.
  await recluster(claim.post_id as number)
}
