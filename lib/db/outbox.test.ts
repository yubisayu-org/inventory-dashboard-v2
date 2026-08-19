import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { createPost, getPost } from "./claims"
import { queueShelfPost, nextPending, markSent, markFailed } from "./outbox"

const EVENT = `TESTOUT${process.hrtime.bigint()}`
const GROUP = `${process.hrtime.bigint()}@g.us`

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
})

after(async () => {
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM wa_groups WHERE jid = ${GROUP}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

async function shelf() {
  return createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "Nishimatsuya", countryId: null, pricingMethod: null, note: "rak 2", safeHues: [],
  })
}

test("a trip with no group queues nothing, and says so", async () => {
  const { id } = await shelf()
  assert.equal(await queueShelfPost(id, EVENT), false)
  assert.equal(await nextPending(), null, "an upload is useful even with nobody to tell")
})

test("a queued shelf comes back with what the caption needs", async () => {
  await sql`
    INSERT INTO wa_groups (jid, name, event, active) VALUES (${GROUP}, 'Test', ${EVENT}, true)
    ON CONFLICT (jid) DO UPDATE SET event = ${EVENT}, active = true
  `
  const { id } = await shelf()
  assert.equal(await queueShelfPost(id, EVENT), true)

  const item = await nextPending()
  assert.equal(item?.postId, id)
  assert.equal(item?.groupJid, GROUP)
  assert.equal(item?.store, "Nishimatsuya")
  assert.equal(item?.note, "rak 2")
})

test("queueing the same shelf twice does not post it twice", async () => {
  const { id } = await shelf()
  await queueShelfPost(id, EVENT)
  await queueShelfPost(id, EVENT)

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM wa_outbox WHERE post_id = ${id}`
  assert.equal(count, 1)
})

/** This shelf's own outbox row. nextPending() is FIFO across the whole queue,
 *  so it hands back whatever an earlier test left waiting. */
async function rowFor(postId: number): Promise<number> {
  const [row] = await sql`SELECT id FROM wa_outbox WHERE post_id = ${postId}`
  return row.id as number
}

test("sending records the message on the post, so replies resolve to it", async () => {
  const { id } = await shelf()
  await queueShelfPost(id, EVENT)

  await markSent(await rowFor(id), id, "MSG-123", GROUP)

  const post = await getPost(id)
  assert.equal(post?.messageId, "MSG-123", "a quoted reply is matched by this")
  assert.equal(post?.groupJid, GROUP)
})

test("a failure is kept with its reason, not retried forever", async () => {
  const { id } = await shelf()
  await queueShelfPost(id, EVENT)
  const outboxId = await rowFor(id)

  await markFailed(outboxId, "group not found")

  const [row] = await sql`SELECT state, error FROM wa_outbox WHERE id = ${outboxId}`
  assert.equal(row.state, "failed")
  assert.equal(row.error, "group not found")

  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM wa_outbox WHERE id = ${outboxId} AND state = 'pending'
  `
  assert.equal(count, 0, "and it stops being offered")
})
