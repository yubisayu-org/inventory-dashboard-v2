/**
 * Turning the add-order form into rows.
 *
 * The form has two modes that are transposes of one another: one customer
 * against many items, which is how orders have always been entered, and one
 * item against many customers, for the trip where the same thing is going to
 * half a dozen people. Both produce the same array — appendOrders and the
 * orders endpoint already take a list and do not care which axis made it.
 *
 * Its own file because getting the pairing wrong bills the wrong person, and
 * nothing downstream would notice: every row is individually well formed. That
 * is worth a test, and a test wants this out of a 1,400-line component.
 */

export type OrderFormMode = "byCustomer" | "byItem"

/** A line as the form holds it — strings, because inputs give strings. */
export type OrderFormLine = {
  /** Set in byCustomer mode. */
  productId: string
  /** Set in byItem mode. */
  customer: string
  unit: string
  note: string
}

export type OrderRowDraft = {
  event: string
  customer: string
  productId: number
  unitPrice: number
  unit: number
  note: string
}

/**
 * `fixed` is whichever side does not repeat: the customer's handle in
 * byCustomer mode, the product id in byItem mode.
 *
 * Lines with nothing on the repeated side are dropped — an empty row left at
 * the bottom of the form is how it looks, not an order for nobody.
 */
export function rowsFromForm(input: {
  mode: OrderFormMode
  event: string
  fixed: string
  lines: OrderFormLine[]
  priceOf: (productId: number) => number
}): OrderRowDraft[] {
  const { mode, event, fixed, lines, priceOf } = input

  return lines
    .map((line) => {
      const customer = mode === "byCustomer" ? fixed : line.customer.trim()
      const productId = Number(mode === "byCustomer" ? line.productId : fixed)
      return { customer, productId, unit: Number(line.unit), note: line.note }
    })
    .filter((r) => r.customer !== "" && Number.isFinite(r.productId) && r.productId > 0)
    .map((r) => ({
      event,
      customer: r.customer,
      productId: r.productId,
      unitPrice: priceOf(r.productId),
      unit: r.unit,
      note: r.note,
    }))
}
