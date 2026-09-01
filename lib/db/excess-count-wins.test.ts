import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { reconcileExcessOnArrival, getExcessPurchaseRows } from "./orders"
import { getExcessArrivalPending } from "./fulfillment"
import { getExcessDispatchPending } from "./dispatch"

/**
 * What is in the box beats what the paperwork says.
 *
 * An excess row's three counters -- bought, dispatched, arrived -- climb in
 * order, each capped by the one before it. Right for a customer's line, where
 * `unit_dispatch` is a promise. Wrong for surplus: how many spare units were
 * bought is a number nobody knows until the box is open, and it was being asked
 * for weeks earlier at a desk that had no idea which parcel they would ride in.
 *
 * Correcting it later on the Inventory page was the only way, and it asked for
 * the receipt at exactly the moment the receipt is no longer in front of you.
 */

const EVENT = `excnt${process.hrtime.bigint()}`
const ITEM = "Rotating Hanger Square"
const ids: number[] = []

let eventReady = false
async function seed(unitBuy: number, unitDispatch: number, unitArrive: number) {
  if (!eventReady) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
    eventReady = true
  }
  const [r] = (await sql`
    INSERT INTO excess_purchase (event, items, unit_buy, unit_dispatch, unit_arrive, receipt, reason)
    VALUES (${EVENT}, ${ITEM}, ${unitBuy}, ${unitDispatch}, ${unitArrive}, 'CJI-2607', 'overbuy')
    RETURNING id
  `) as unknown as { id: number }[]
  ids.push(r.id)
  return r.id
}

async function row(id: number) {
  return (await getExcessPurchaseRows()).find((r) => r.rowNumber === id)!
}

test("counting more than the box was carrying raises the row to the count", async () => {
  // Bought 3, shipped 3 — and five come out of the parcel.
  const id = await seed(3, 3, 0)
  await reconcileExcessOnArrival({ rowNumber: id, unitBuy: 5, unitDispatch: 5, unitArrive: 5 })

  const r = await row(id)
  assert.equal(r.unitBuy, 5, "she bought five and miscounted — the row was wrong, not the hangers")
  assert.equal(r.unitDispatch, 5, "and five travelled, whatever the paperwork claimed")
  assert.equal(r.unitArrive, 5)
})

test("a row raised to the count is finished, not owing more", async () => {
  const id = await seed(3, 3, 0)
  await reconcileExcessOnArrival({ rowNumber: id, unitBuy: 5, unitDispatch: 5, unitArrive: 5 })

  const arriving = (await getExcessArrivalPending(EVENT)).map((r) => r.rowNumber)
  const dispatching = (await getExcessDispatchPending(EVENT)).map((r) => r.rowNumber)
  assert.ok(!arriving.includes(id), "nothing left to arrive")
  assert.ok(!dispatching.includes(id), "and raising unit_buy must not bounce it back to the dispatch list")
})

test("all five reach the shelf, not the three the row used to claim", async () => {
  const id = await seed(3, 3, 0)
  await reconcileExcessOnArrival({ rowNumber: id, unitBuy: 5, unitDispatch: 5, unitArrive: 5 })

  // Ready stock counts LEAST(unit_arrive, unit_buy) — five arrived against a
  // unit_buy of three would have offered three and stranded two in the
  // warehouse, real and orderable by nobody.
  const [r] = (await sql`
    SELECT LEAST(COALESCE(unit_arrive, 0), unit_buy)::int AS ready
      FROM excess_purchase WHERE id = ${id}
  `) as unknown as { ready: number }[]
  assert.equal(r.ready, 5)
})

test("counting fewer and closing the row settles it at what landed", async () => {
  // Three shipped, two in the box, and the third is not coming.
  const id = await seed(3, 3, 0)
  await reconcileExcessOnArrival({ rowNumber: id, unitBuy: 2, unitDispatch: 2, unitArrive: 2 })

  const r = await row(id)
  assert.equal(r.unitArrive, 2)
  assert.equal(r.unitDispatch, 2, "or the row goes on showing one unit pending forever")
  assert.equal(r.unitBuy, 2, "and unit_buy above dispatch would send it back to the dispatch list")

  const arriving = (await getExcessArrivalPending(EVENT)).map((x) => x.rowNumber)
  const dispatching = (await getExcessDispatchPending(EVENT)).map((x) => x.rowNumber)
  assert.ok(!arriving.includes(id) && !dispatching.includes(id), "closed means gone from both lists")
})

test("a partial count that is NOT closed keeps the rest pending", async () => {
  // The difference between "the third is lost" and "the third is on the next
  // boat" is a judgement, so writing the row down is never automatic.
  const id = await seed(3, 3, 0)
  await sql`UPDATE excess_purchase SET unit_arrive = 2 WHERE id = ${id}`

  const pending = (await getExcessArrivalPending(EVENT)).find((x) => x.rowNumber === id)
  assert.ok(pending, "still listed")
  assert.equal(pending!.pending, 1)
})

test("what the row used to say survives in the audit log", async () => {
  const id = await seed(3, 3, 0)
  await reconcileExcessOnArrival({ rowNumber: id, unitBuy: 2, unitDispatch: 2, unitArrive: 2 })

  // Writing the row down costs the page its record of the third unit. It is not
  // lost outright -- every write keeps old_row and new_row -- but reading it
  // back means the audit log, not the Inventory screen.
  const [entry] = (await sql`
    SELECT (old_row->>'unit_buy')::int AS was, (new_row->>'unit_buy')::int AS now
      FROM audit.audit_log
     WHERE table_name = 'excess_purchase'
       AND (new_row->>'id')::int = ${id}
       AND action = 'UPDATE'
     ORDER BY at DESC LIMIT 1
  `) as unknown as { was: number; now: number }[]
  assert.equal(entry?.was, 3, "three were bought")
  assert.equal(entry?.now, 2, "two were kept")
})

test("packing more than the row says was bought raises it at dispatch", async () => {
  // Learnt at the hotel, with the goods in hand: the row says two spare units,
  // there are five on the table. Correcting it here means not carrying "there
  // were really five" in her head until the parcel is opened weeks later.
  const id = await seed(2, 0, 0)
  await reconcileExcessOnArrival({ rowNumber: id, unitBuy: 5, unitDispatch: 5, unitArrive: 0 })

  const r = await row(id)
  assert.equal(r.unitBuy, 5)
  assert.equal(r.unitDispatch, 5)
  assert.equal(r.unitArrive, 0, "nothing has arrived yet — this is the dispatch stage")
})

test("a correction at dispatch carries through receiving and onto the shelf", async () => {
  // Each stage is capped by the one before it, so raising unit_dispatch without
  // unit_buy would leave ready stock clamped by LEAST(unit_arrive, unit_buy)
  // and strand three real units nobody can order.
  const id = await seed(2, 0, 0)
  await reconcileExcessOnArrival({ rowNumber: id, unitBuy: 5, unitDispatch: 5, unitArrive: 0 })

  const pending = (await getExcessArrivalPending(EVENT)).find((x) => x.rowNumber === id)
  assert.equal(pending?.pending, 5, "the receiving list asks for all five")

  await sql`UPDATE excess_purchase SET unit_arrive = 5 WHERE id = ${id}`
  const [shelf] = (await sql`
    SELECT LEAST(COALESCE(unit_arrive, 0), unit_buy)::int AS ready
      FROM excess_purchase WHERE id = ${id}
  `) as unknown as { ready: number }[]
  assert.equal(shelf.ready, 5, "and all five reach the shelf")

  const arriving = (await getExcessArrivalPending(EVENT)).map((x) => x.rowNumber)
  const dispatching = (await getExcessDispatchPending(EVENT)).map((x) => x.rowNumber)
  assert.ok(!arriving.includes(id) && !dispatching.includes(id), "settled, in both lists")
})

after(async () => {
  if (ids.length > 0) await sql`DELETE FROM excess_purchase WHERE id = ANY(${ids})`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})
