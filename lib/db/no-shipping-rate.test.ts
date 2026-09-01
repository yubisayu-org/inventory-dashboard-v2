import { test } from "node:test"
import assert from "node:assert/strict"
import { shipCustomerOrders, shipMergedCustomerOrders, NoShippingRateError } from "./fulfillment"

// ongkirPerKg arrives in the request body and is written straight onto the
// shipment, so a zero is not an error state — it is the price. The card had an
// amber "Ongkir belum ada" pill and nothing else, and bulk ship never showed
// even that: one press could send any number of unbilled parcels.
//
// Refused before anything is written, because a parcel billed nothing is not
// recoverable by setting the rate afterwards — the shipment keeps the figure
// it was sent, and she has already been told what she owes.
test("shipping one trip with no rate is refused before anything is written", async () => {
  for (const ongkirPerKg of [0, -1, undefined, null, NaN]) {
    await assert.rejects(
      () => shipCustomerOrders({
        customer: "@nobody", event: "NORATE01", weightKg: 1,
        orders: [{ rowNumber: 1, productName: "x", toShip: 1, gram: 500 }],
        ongkirPerKg: ongkirPerKg as number,
      }),
      NoShippingRateError,
      String(ongkirPerKg),
    )
  }
})

test("shipping a merged box with no rate is refused, and names every trip in it", async () => {
  await assert.rejects(
    () => shipMergedCustomerOrders({
      customer: "@nobody",
      ongkirPerKg: 0,
      groups: [
        { event: "NORATE01", orders: [] },
        { event: "NORATE02", orders: [] },
      ],
    }),
    (err: Error) => {
      assert.ok(err instanceof NoShippingRateError)
      // One rate covers the whole box, so one missing rate voids the merge —
      // and the message has to say which trips are affected, not just that
      // something is.
      assert.deepEqual(err.events, ["NORATE01", "NORATE02"])
      assert.match(err.message, /NORATE01, NORATE02/)
      return true
    },
  )
})

// It reaches a human as a sentence naming the fix, not "Failed to ship orders".
test("the refusal says what to do about it", () => {
  const err = new NoShippingRateError(["LSFT202607"])
  assert.match(err.message, /Belum ada ongkir/)
  assert.match(err.message, /atur tarifnya dulu/)
  assert.match(err.message, /LSFT202607/)
})
