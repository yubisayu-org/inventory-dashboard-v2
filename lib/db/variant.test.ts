import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { duplicateProductAsVariant } from "./orders"

const TAG = "varianttest"
let sourceId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (
      name, store, price, gram, valas, kurs, cargo_per_kg, profit_pct,
      operational_fee, packing_fee, cost, profit_fixed, pricing_method, flat_fee_mode
    ) VALUES (
      ${`${TAG} source`}, 'MUJI', 385000, 780, 3200, 108.5, 90000, 22,
      5000, 5000, 260000, 15000, 'overseas', 'fixed'
    ) RETURNING id`
  sourceId = p.id
})

after(async () => {
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

test("the copy inherits every commercial field, and only the name differs", async () => {
  // The point of moving this server-side: these are the columns staff must not
  // be handed in order to copy them.
  const made = await duplicateProductAsVariant(sourceId, `${TAG} navy`)
  const [src] = await sql`SELECT * FROM products WHERE id = ${sourceId}`
  const [copy] = await sql`SELECT * FROM products WHERE id = ${made.id}`

  for (const col of [
    "store", "price", "gram", "country_id", "valas", "kurs", "cargo_per_kg",
    "profit_pct", "operational_fee", "packing_fee", "cost", "profit_fixed",
    "is_active", "pricing_method", "tiered_kurs", "flat_fee_mode",
  ]) {
    assert.deepEqual(copy[col], src[col], col)
  }
  assert.equal(copy.name, `${TAG} navy`)
  assert.notEqual(copy.id, src.id)
  assert.equal(made.price, src.price, "the caller is told the price it will charge")
})

test("a blank name is refused before anything is written", async () => {
  await assert.rejects(() => duplicateProductAsVariant(sourceId, "   "), /name is required/i)
})

test("copying a product that is gone says so rather than writing a nameless row", async () => {
  await assert.rejects(
    () => duplicateProductAsVariant(2_000_000_000, `${TAG} orphan`),
    /no longer exists/,
  )
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM products WHERE name = ${`${TAG} orphan`}`
  assert.equal(n, 0)
})
