import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { withActor } from "./actor"
import { recordDispatchManifest, getEventBoxes, getBoxManifest } from "./dispatch-manifest"
import {
  getCargo, getEventCargos, getUncodedByCargo, getBoxCargo, setCargoWeight,
  describeCargo, renameCargo, setBoxCargo,
} from "./cargo"
import { updateOperationalExpense } from "./operational-expenses"

/**
 * A cargo is the delivery, not the box.
 *
 * The shapes here are the ones that decided the design: one cargo carrying
 * boxes from two trips, units counted in with a cargo but no box, and a cost
 * that is two bills rather than one number.
 */
const TAG = `cargo${process.hrtime.bigint()}`
const TRIP_A = `${TAG}_A`
const TRIP_B = `${TAG}_B`
const CARGO = `${TAG}-9981`
const BOX_ONE = `${TAG}-14`
const BOX_TWO = `${TAG}-10`
let productId = 0
const orders: Record<string, number> = {}

async function seed(key: string, trip: string, box: string, cargo: string, units: number) {
  const customer = `${TAG}_${key}`
  await sql`INSERT INTO customers (instagram_id) VALUES (${customer})`
  // Priced everywhere, so this fixture never turns up in another file's "who
  // cannot be quoted" list -- which is capped, and would drop its own row.
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    SELECT c.id, w.id, 10000 FROM customers c CROSS JOIN warehouses w
     WHERE c.instagram_id = ${customer}
    ON CONFLICT (customer_id, warehouse_id) DO NOTHING`
  const [o] = (await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch,
                        dispatch_receipt, cargo_receipt)
    VALUES (${trip}, ${customer}, ${productId}, 100000, ${units}, ${units}, ${units}, ${box}, ${cargo})
    RETURNING id`) as unknown as { id: number }[]
  orders[key] = o.id
  return o.id
}

/** Count units in the way arrival does, so the audit log gets its rows. */
async function countIn(key: string, units: number) {
  await withActor("tester", (tx) => tx`
    UPDATE orders SET unit_arrive = COALESCE(unit_arrive, 0) + ${units}, updated_at = NOW()
     WHERE id = ${orders[key]}`)
}

async function expense(trip: string, desc: string, amount: number, cargo: string | null) {
  const [e] = (await sql`
    INSERT INTO operational_expenses (event, expense_date, description, category, amount_idr, method, cargo_receipt)
    VALUES (${trip}, CURRENT_DATE, ${desc}, 'Cargo', ${amount}, '1497', ${cargo})
    RETURNING id`) as unknown as { id: number }[]
  return e.id
}

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    SELECT id FROM products WHERE COALESCE(gram, 0) = 0 ORDER BY id LIMIT 1`
  productId = p.id
  for (const t of [TRIP_A, TRIP_B]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${t}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  await recordDispatchManifest([
    { event: TRIP_A, productId, receipt: BOX_ONE, qty: 10 },
    { event: TRIP_B, productId, receipt: BOX_TWO, qty: 6 },
  ])
  // One cargo, two trips, two boxes — plus a pile with no box code.
  await seed("one", TRIP_A, BOX_ONE, CARGO, 10)
  await seed("two", TRIP_B, BOX_TWO, CARGO, 6)
  await seed("loose", TRIP_A, "", CARGO, 4)
  await seed("nothing", TRIP_A, "", "", 3)
  await countIn("one", 9)
  await countIn("two", 6)
  await countIn("loose", 4)
  await countIn("nothing", 3)
})

after(async () => {
  await sql`DELETE FROM operational_expenses WHERE event IN (${TRIP_A}, ${TRIP_B})`
  await sql`DELETE FROM dispatch_manifest WHERE event IN (${TRIP_A}, ${TRIP_B})`
  await sql`DELETE FROM orders WHERE event IN (${TRIP_A}, ${TRIP_B})`
  await sql`DELETE FROM events WHERE name IN (${TRIP_A}, ${TRIP_B})`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql`DELETE FROM cargos WHERE receipt = ${CARGO}`
  await sql.end()
})

test("a cargo carries boxes from more than one trip", async () => {
  const c = (await getCargo(CARGO))!
  assert.equal(c.boxes.length, 2, "both boxes, whichever trip they belong to")
  assert.deepEqual(c.events.sort(), [TRIP_A, TRIP_B].sort())
  assert.equal(c.received, 19, "9 + 6 in boxes, 4 loose")
  assert.equal(c.looseUnits, 4, "counted in against the cargo with no box named")
})

test("a box takes its cargo from the arrivals that filled it", async () => {
  assert.equal(await getBoxCargo(BOX_ONE), CARGO.toUpperCase())
  assert.equal(await getBoxCargo(`${TAG}-nope`), null)
})

test("the cost is the bills, and there is no other copy", async () => {
  const before = (await getCargo(CARGO))!
  assert.equal(before.cost, 0, "no bill, no cost — not a zero somebody typed")

  const freight = await expense(TRIP_A, "CJI", 4_100_000, CARGO)
  await expense(TRIP_A, "CJI customs", 750_000, CARGO)

  const after = (await getCargo(CARGO))!
  assert.equal(after.bills.length, 2, "a cargo can be more than one bill — yours are")
  assert.equal(after.cost, 4_850_000)

  // Correcting the ledger corrects the cargo, because it is the same number.
  await sql`UPDATE operational_expenses SET amount_idr = 3_750_000 WHERE id = ${freight}`
  assert.equal((await getCargo(CARGO))!.cost, 4_500_000, "one number, corrected once")
})

test("a bill is attached where bills are edited, and the money never moves", async () => {
  const loose = await expense(TRIP_A, "Karina", 6_384_000, null)
  const fields = {
    event: TRIP_A, expenseDate: new Date().toISOString().slice(0, 10), description: "Karina",
    category: "Cargo" as const, amountForeign: 6_384_000, rate: 1, amountIdr: 6_384_000,
    isSettled: false, method: "1497", remarks: "",
  }

  // The one writer: the expense row itself, on Operational Expenses. There is
  // no second place to attach a bill, so there is no second place to correct.
  await updateOperationalExpense(loose, { ...fields, cargoReceipt: CARGO })
  assert.equal((await getCargo(CARGO))!.cost, 10_884_000, "and the cargo's cost follows immediately")

  await updateOperationalExpense(loose, { ...fields, cargoReceipt: "" })
  assert.equal((await getCargo(CARGO))!.cost, 4_500_000, "let go again")
  const [row] = await sql<{ amount: number }[]>`
    SELECT amount_idr::int AS amount FROM operational_expenses WHERE id = ${loose}`
  assert.equal(row.amount, 6_384_000, "the amount itself never moved")
})

test("weight is the only figure the cargo keeps", async () => {
  await setCargoWeight(CARGO, 312)
  const c = (await getCargo(CARGO))!
  assert.equal(c.weightKg, 312)
  assert.equal(Math.round(c.cost / c.weightKg!), 14_423, "per kg is arithmetic, not a stored figure")
})

test("a trip lists the cargo its arrivals name", async () => {
  const list = await getEventCargos(TRIP_A)
  const mine = list.find((c) => c.receipt === CARGO.toUpperCase())!
  assert.ok(mine, "the cargo appears on the trip it delivered to")
  assert.equal(mine.boxes, 1, "one box of this cargo belongs to this trip")
  assert.equal(mine.looseUnits, 4)
})

test("units with no box code are split by the cargo they name", async () => {
  const piles = await getUncodedByCargo(TRIP_A)
  assert.equal(piles.length, 2)
  assert.equal(piles[0].cargo, CARGO.toUpperCase(), "the pile that at least names a cargo comes first")
  assert.equal(piles[0].units, 4)
  assert.equal(piles[1].cargo, null, "and the pile with neither is last")
  assert.equal(piles[1].units, 3)
})

test("a cargo nobody has counted anything against does not exist", async () => {
  assert.equal(await getCargo(`${TAG}-never`), null)
  assert.equal(await getCargo("  "), null)
})

test("the strip says which delivery each box came on", async () => {
  const cards = await getEventBoxes(TRIP_A)
  const card = cards.find((b) => b.receipt === BOX_ONE)!
  assert.equal(card.cargo, CARGO.toUpperCase(), "in its own slot, beside the box code")
  assert.equal(card.received, 9, "and the box's own count is untouched by it")
})

test("an opened box names its delivery too", async () => {
  const m = (await getBoxManifest(BOX_ONE))!
  assert.equal(m.cargo, CARGO.toUpperCase())

  // A box nobody counted in against a cargo says so plainly, rather than
  // borrowing one from a box beside it.
  await recordDispatchManifest([{ event: TRIP_A, productId, receipt: `${TAG}-solo`, qty: 2 }])
  const solo = (await getBoxManifest(`${TAG}-solo`))!
  assert.equal(solo.cargo, null)
})

/**
 * Correcting a code, which only she can judge.
 *
 * Nothing in the data separates "typed CJI-9918 for CJI-9981" from "CJI-9918
 * is a second delivery". So neither write guesses: one moves the whole
 * delivery, the other moves one box, and what is already under the target is
 * reported rather than resolved.
 */
const TYPO = `${TAG}-9918`

test("what is already under a code is reported before anything is written", async () => {
  const there = await describeCargo(CARGO)
  assert.equal(there.known, true)
  assert.equal(there.boxes, 2)
  assert.equal(there.units, 19)

  const empty = await describeCargo(`${TAG}-0000`)
  assert.equal(empty.known, false, "nothing uses it, so renaming into it merges nothing")
})

test("renaming the delivery takes every box, the loose units and the bills", async () => {
  // A batch counted in under a code that is one digit wrong, boxes and a
  // pile with no box code alike.
  await sql`UPDATE orders SET cargo_receipt = ${TYPO} WHERE event = ${TRIP_A}`
  const bill = await expense(TRIP_A, "Freight, mistyped", 1_200_000, TYPO)

  const before = (await getCargo(TYPO))!
  assert.ok(before.looseUnits > 0, "the pile no per-box control could reach")

  const { movedOrders, movedBills } = await renameCargo(TYPO, CARGO)
  assert.ok(movedOrders >= 3)
  assert.equal(movedBills, 1, "the cost follows, or it is lost on a code nothing uses")

  assert.equal(await getCargo(TYPO), null, "the mistyped delivery stops existing")
  const after = (await getCargo(CARGO))!
  assert.equal(after.looseUnits, before.looseUnits, "the loose units came along")
  assert.ok(after.bills.some((b) => b.id === bill), "and so did the bill")
})

test("moving one box leaves the rest of the delivery where it was", async () => {
  const other = `${TAG}-7702`
  const before = (await getCargo(CARGO))!

  await setBoxCargo(BOX_TWO, other)

  const left = (await getCargo(CARGO))!
  assert.ok(!left.boxes.some((b) => b.receipt === BOX_TWO), "the box left")
  assert.ok(left.boxes.some((b) => b.receipt === BOX_ONE), "the others stayed")
  assert.equal(left.cost, before.cost, "and no money moved with it — a bill is raised for a shipment")
  assert.equal(await getBoxCargo(BOX_TWO), other.toUpperCase())

  // Blank is a real answer: the code on it is wrong and she does not yet know
  // which delivery it was.
  await setBoxCargo(BOX_TWO, "")
  assert.equal(await getBoxCargo(BOX_TWO), null)
})
