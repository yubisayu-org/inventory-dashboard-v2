import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { createPost, getPost } from "../db/claims"
import { archiveEvent } from "./archive"
import { renderShoppingList } from "./render"

const EVENT = `TESTARCH${process.hrtime.bigint()}`

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id, is_active)
    SELECT ${EVENT}, id, false FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
})

after(async () => {
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

/** A shelf whose "original" is a local fixture, so nothing touches the bucket. */
async function shelf() {
  return createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "Nishimatsuya", countryId: null, pricingMethod: null, note: "", safeHues: [130],
  })
}

test("a running trip refuses to be archived", async () => {
  await sql`UPDATE events SET is_active = true WHERE name = ${EVENT}`
  await assert.rejects(() => archiveEvent(EVENT), /still running/)
  await sql`UPDATE events SET is_active = false WHERE name = ${EVENT}`
})

test("an unknown trip is an error, not a silent no-op", async () => {
  await assert.rejects(() => archiveEvent("NOSUCHEVENT"), /no such event/)
})

test("a shelf whose image cannot be read keeps its row untouched", async () => {
  // No original to copy from, so no catalogue copy can be written — and a rack
  // that cannot be shown must not be marked archived, or the screens have
  // nothing to fall back to.
  const { id } = await createPost({
    event: EVENT, imagePath: "missing/gone.jpg", imageWidth: 100, imageHeight: 100,
    store: "Nishimatsuya", countryId: null, pricingMethod: null, note: "", safeHues: [],
  })
  const result = await archiveEvent(EVENT)

  assert.equal(result.skipped, 1)
  const post = await getPost(id)
  assert.equal(post?.archivedAt, null, "an unshowable shelf is not archived")
})

test("a closed trip loses its originals and gains catalogue copies", async () => {
  const { id } = await shelf()
  const result = await archiveEvent(EVENT)

  assert.ok(result.archived >= 1)
  const post = await getPost(id)
  assert.ok(post?.archivedAt, "the shelf is marked archived")
  assert.ok(post?.viewPath.endsWith(".avif"), "and keeps a copy to show")
})

test("an archived shelf still renders, from the copy that remains", async () => {
  const { id } = await shelf()
  // Stand in for a successful archive: the copy exists, the original is gone.
  await sql`
    UPDATE wa_posts SET view_path = ${FIXTURES.crop}, archived_at = NOW(), image_path = 'gone.jpg'
    WHERE id = ${id}
  `
  const image = await renderShoppingList(id)
  assert.ok(image.length > 0, "the rekap picture falls back to the catalogue copy")
})
