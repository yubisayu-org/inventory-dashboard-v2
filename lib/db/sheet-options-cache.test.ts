import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getCachedSheetOptions, optionsFingerprint, forgetSheetOptions } from "./sheet-options-cache"

/**
 * The pickers' lists are rebuilt when something changes, and not otherwise.
 *
 * The old route refused to cache for a good reason -- a product added upstairs
 * has to show up in the picker downstairs -- so the test that matters is not
 * "it caches" but "it notices".
 */
const TAG = `optcache${process.hrtime.bigint()}`

after(async () => {
  await sql`DELETE FROM products WHERE name = ${TAG}`
  forgetSheetOptions()
  await sql.end()
})

test("asked twice with nothing written in between, the database is read once", async () => {
  forgetSheetOptions()
  const first = await getCachedSheetOptions()
  const second = await getCachedSheetOptions()

  assert.equal(first.fingerprint, second.fingerprint)
  // The same object, not an equal one: a second read of every product and
  // every customer is exactly what this exists to avoid.
  assert.equal(first.options, second.options)
})

test("a new product moves the fingerprint, and the lists are rebuilt", async () => {
  const before = await getCachedSheetOptions()
  assert.ok(!before.options.items.some((i) => i.name === TAG))

  await sql`INSERT INTO products (name, store, price) VALUES (${TAG}, ${TAG}, 1000)`

  // Postgres reports its per-table write counters on a flush interval rather
  // than at commit, so the picker trails a real change by up to a second. That
  // is the honest cost of reading the counters instead of the tables, and a
  // second is not a wait anybody notices in a dropdown.
  let after = await getCachedSheetOptions()
  for (let i = 0; i < 40 && after.fingerprint === before.fingerprint; i++) {
    await new Promise((r) => setTimeout(r, 100))
    after = await getCachedSheetOptions()
  }

  assert.notEqual(after.fingerprint, before.fingerprint, "the write counters moved")
  assert.notEqual(after.options, before.options, "so the copy was thrown away")
  assert.ok(after.options.items.some((i) => i.name === TAG), "and the picker has it")
})

test("the fingerprint is one short string, whatever the tables hold", async () => {
  const f = await optionsFingerprint()
  assert.match(f, /products:\d+/)
  assert.match(f, /customers:\d+/)
  assert.ok(f.length < 200, "short enough to be an ETag")
})
