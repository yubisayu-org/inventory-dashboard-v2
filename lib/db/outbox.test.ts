import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { createPost, getPost } from "./claims"
import { createSend } from "./wa-sends"
import {
  queueShelfPost, nextPending, markSent, markFailed,
  queueSend, nextPendingSend, markSendSent,
} from "./outbox"

const EVENT = `TESTOUT${process.hrtime.bigint()}`
const GROUP = `${process.hrtime.bigint()}@g.us`

// Separate event/group/post for the send-outbox suite below, so the shelf
// suite above (which shares the queue table) cannot cross-contaminate it.
const SEND_EVENT = `TESTOUTSEND${process.hrtime.bigint()}`
const SEND_GROUP = `${process.hrtime.bigint()}@g.us`
let sendPostId: number

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${SEND_EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await sql`
    INSERT INTO wa_groups (jid, event, active) VALUES (${SEND_GROUP}, ${SEND_EVENT}, true)
    ON CONFLICT (jid) DO UPDATE SET event = EXCLUDED.event
  `
  const [post] = await sql`
    INSERT INTO catalogue_posts (media_url, media_type) VALUES ('https://example.com/t.jpg', 'photo')
    RETURNING id
  `
  sendPostId = post.id as number
})

after(async () => {
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM wa_groups WHERE jid = ${GROUP}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`

  await sql`DELETE FROM wa_outbox WHERE send_id IN (SELECT id FROM wa_sends WHERE event = ${SEND_EVENT})`
  await sql`DELETE FROM wa_sends WHERE event = ${SEND_EVENT}`
  await sql`DELETE FROM catalogue_posts WHERE id = ${sendPostId}`
  await sql`DELETE FROM wa_groups WHERE jid = ${SEND_GROUP}`
  await sql`DELETE FROM events WHERE name = ${SEND_EVENT}`

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

test("queueSend finds the group bound to the event and queues one row", async () => {
  const { id: sendId } = await createSend({ postId: sendPostId, event: SEND_EVENT, title: "t" })
  const queued = await queueSend(sendId, SEND_EVENT, "the caption")
  assert.equal(queued, true)

  const item = await nextPendingSend()
  assert.equal(item?.sendId, sendId)
  assert.equal(item?.groupJid, SEND_GROUP)
  assert.equal(item?.caption, "the caption")
  assert.equal(item?.mediaUrl, "https://example.com/t.jpg")

  // nextPendingSend() only reads the queue, it doesn't consume it — clean up
  // this row explicitly (same pattern wa-sends.test.ts uses for wa_sends/
  // wa_groups) so it doesn't leak into a later test's FIFO order.
  await sql`DELETE FROM wa_outbox WHERE id = ${item!.id}`
})

test("queueSend returns false when the trip has no bound group", async () => {
  const orphanEvent = `${SEND_EVENT}-orphan`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${orphanEvent}, id FROM warehouses ORDER BY id LIMIT 1`
  const { id: sendId } = await createSend({ postId: sendPostId, event: orphanEvent, title: "t" })
  const queued = await queueSend(sendId, orphanEvent, "caption")
  assert.equal(queued, false)
  await sql`DELETE FROM wa_sends WHERE id = ${sendId}`
  await sql`DELETE FROM events WHERE name = ${orphanEvent}`
})

test("re-queueing an already-queued send does not duplicate the row", async () => {
  const { id: sendId } = await createSend({ postId: sendPostId, event: SEND_EVENT, title: "t" })
  await queueSend(sendId, SEND_EVENT, "caption")
  await queueSend(sendId, SEND_EVENT, "caption")
  const [{ count }] = await sql`SELECT count(*)::int FROM wa_outbox WHERE send_id = ${sendId}`
  assert.equal(count, 1)

  // As above: leaving this pending would shadow the next test's own queued
  // row when nextPendingSend() picks the oldest one first.
  await sql`DELETE FROM wa_outbox WHERE send_id = ${sendId}`
})

test("markSendSent records the message id on both the outbox row and the send", async () => {
  const { id: sendId } = await createSend({ postId: sendPostId, event: SEND_EVENT, title: "t" })
  await queueSend(sendId, SEND_EVENT, "caption")
  const item = await nextPendingSend()
  await markSendSent(item!.id, sendId, "msg-1", SEND_GROUP)

  const [outboxRow] = await sql`SELECT state, message_id FROM wa_outbox WHERE id = ${item!.id}`
  assert.equal(outboxRow.state, "sent")
  assert.equal(outboxRow.message_id, "msg-1")

  const [sendRow] = await sql`SELECT message_id, group_jid FROM wa_sends WHERE id = ${sendId}`
  assert.equal(sendRow.message_id, "msg-1")
  assert.equal(sendRow.group_jid, SEND_GROUP)
})

test("nextPendingSend skips a shelf row (post_id) and only returns send rows", async () => {
  // Sanity check that the shared table's two shapes don't cross-contaminate.
  // By this point in the file every send queued above has either been marked
  // sent or explicitly cleaned up by the test that queued it, so the queue of
  // *sends* should be empty even though the queue of *shelves* (from the
  // suite above) is not.
  const before = await nextPendingSend()
  assert.equal(before, null, "queue should be empty of sends at this point in the file")
})
