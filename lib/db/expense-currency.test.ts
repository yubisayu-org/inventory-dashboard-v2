import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { addOperationalExpense, updateOperationalExpense } from "./operational-expenses"

const TAG = `expcur${process.hrtime.bigint()}`

after(async () => {
  await sql`DELETE FROM operational_expenses WHERE description LIKE ${`${TAG}%`}`
  await sql.end()
})

/** Read the row back the way the screen does — through the mapper. */
async function currencyOf(rowNumber: number): Promise<string | null> {
  const [r] = await sql<{ currency: string | null }[]>`
    SELECT currency FROM operational_expenses WHERE id = ${rowNumber}`
  return r?.currency ?? null
}

const base = {
  event: "", expenseDate: "", category: "Shop" as const,
  amountForeign: 100, rate: 16000, amountIdr: 1600000,
  isSettled: false, method: "", remarks: "",
}

test("an expense with no event remembers what it was paid in", async () => {
  // The whole bug: no event means nothing to infer a currency from, so a USD
  // expense opened as "FX" however carefully USD was chosen.
  const { rowNumber } = await addOperationalExpense({
    ...base, description: `${TAG} no event usd`, currency: "USD",
  })
  assert.equal(await currencyOf(rowNumber), "USD")
})

test("editing keeps it, and can correct it", async () => {
  const { rowNumber } = await addOperationalExpense({
    ...base, description: `${TAG} edit me`, currency: "USD",
  })
  await updateOperationalExpense(rowNumber, {
    ...base, description: `${TAG} edit me`, currency: "CNY",
  })
  assert.equal(await currencyOf(rowNumber), "CNY")
})

test("a legacy row has no currency, and is not invented one", async () => {
  // Rate is a ratio: 16000 could be USD or anything else. Guessing here would
  // be worse than the screen's honest fallback.
  const { rowNumber } = await addOperationalExpense({
    ...base, description: `${TAG} legacy`,
  })
  assert.equal(await currencyOf(rowNumber), null)
})
