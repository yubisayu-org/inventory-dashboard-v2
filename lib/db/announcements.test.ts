import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  listAnnouncementsForCustomer,
  markAnnouncementsRead,
  notifyCustomer,
} from "./announcements"

const TAG = `anntest${process.hrtime.bigint()}`

after(async () => {
  await sql`DELETE FROM announcements WHERE title LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

async function customer(): Promise<number> {
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${`${TAG}_${process.hrtime.bigint()}`})
    RETURNING id`
  return c.id
}

/** A customer and the handle a shipment would name her by. */
async function named(): Promise<{ id: number; handle: string }> {
  const handle = `${TAG}_${process.hrtime.bigint()}`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${handle}) RETURNING id`
  return { id: c.id, handle }
}

const mine = <T extends { title: string }>(rows: T[]): T[] =>
  rows.filter((r) => r.title.startsWith(TAG))

test("a published announcement is readable, newest first", async () => {
  await createAnnouncement({ title: `${TAG} older`, body: "first" })
  await createAnnouncement({ title: `${TAG} newer`, body: "second" })
  const rows = mine(await listAnnouncements())
  assert.equal(rows.length, 2)
  assert.equal(rows[0].title, `${TAG} newer`, "newest must lead")
})

test("title and body are trimmed on the way in", async () => {
  const a = await createAnnouncement({ title: `  ${TAG} spaced  `, body: "  padded  " })
  assert.equal(a.title, `${TAG} spaced`)
  assert.equal(a.body, "padded")
})

// A missing read row means unread, so nothing is written when an announcement
// is published — which is also why someone who signs up later still sees it
// as new.
test("everything starts unread for a customer who has never opened the inbox", async () => {
  const id = await customer()
  const rows = mine(await listAnnouncementsForCustomer(id))
  assert.ok(rows.length >= 2)
  assert.ok(rows.every((r) => !r.read))
})

test("marking read applies to that customer alone", async () => {
  const a = await customer()
  const b = await customer()
  await markAnnouncementsRead(a)

  assert.ok(mine(await listAnnouncementsForCustomer(a)).every((r) => r.read))
  assert.ok(mine(await listAnnouncementsForCustomer(b)).every((r) => !r.read))
})

test("marking read twice is not an error", async () => {
  const id = await customer()
  await markAnnouncementsRead(id)
  await markAnnouncementsRead(id)
  assert.ok(mine(await listAnnouncementsForCustomer(id)).every((r) => r.read))
})

// A customer who read everything yesterday must see today's as new.
test("a new announcement is unread even for someone who had cleared their inbox", async () => {
  const id = await customer()
  await markAnnouncementsRead(id)
  const fresh = await createAnnouncement({ title: `${TAG} fresh`, body: "just in" })

  const rows = await listAnnouncementsForCustomer(id)
  const row = rows.find((r) => r.id === fresh.id)
  assert.equal(row?.read, false)
})

test("an edit does not resurrect an announcement as unread", async () => {
  const id = await customer()
  const a = await createAnnouncement({ title: `${TAG} editable`, body: "before" })
  await markAnnouncementsRead(id)
  await updateAnnouncement(a.id, { title: `${TAG} editable`, body: "after" })

  const row = (await listAnnouncementsForCustomer(id)).find((r) => r.id === a.id)
  assert.equal(row?.body, "after")
  assert.equal(row?.read, true, "an edit is not a new announcement")
})

// ON DELETE CASCADE, so a delete cannot leave read rows pointing at nothing.
test("deleting takes its read rows with it", async () => {
  const id = await customer()
  const a = await createAnnouncement({ title: `${TAG} doomed`, body: "bye" })
  await markAnnouncementsRead(id)

  await deleteAnnouncement(a.id)

  const [{ n }] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM announcement_reads WHERE announcement_id = ${a.id}`
  assert.equal(Number(n), 0)
})

test("an empty title is refused by the database, not just the form", async () => {
  await assert.rejects(() => createAnnouncement({ title: "   ", body: "something" }))
})


// ── personal notices ────────────────────────────────────────
// A shipping notice is addressed to one customer. The inbox query is the only
// thing standing between her parcel and someone else's, so it is tested from
// both ends: she sees it, and the next customer does not.
test("a shipping notice reaches its customer and nobody else", async () => {
  const her = await named()
  const other = await customer()
  await notifyCustomer(her.handle, { title: `${TAG} shipped`, body: "one parcel" })

  const hers = mine(await listAnnouncementsForCustomer(her.id))
  assert.equal(hers[0].title, `${TAG} shipped`)
  assert.equal(hers[0].kind, "shipping")

  const theirs = mine(await listAnnouncementsForCustomer(other))
  assert.equal(theirs.find((a) => a.title === `${TAG} shipped`), undefined)
})

test("a broadcast still reaches everyone", async () => {
  const her = await customer()
  await createAnnouncement({ title: `${TAG} everyone`, body: "hello" })
  const hers = mine(await listAnnouncementsForCustomer(her))
  assert.ok(hers.some((a) => a.title === `${TAG} everyone`))
  assert.equal(hers.find((a) => a.title === `${TAG} everyone`)?.kind, "notice")
})

// @-prefixed, upper-case, however the shipment happens to spell her.
test("the handle is matched the way every other lookup matches it", async () => {
  const her = await named()
  await notifyCustomer(`@${her.handle.toUpperCase()}`, { title: `${TAG} loose`, body: "x" })
  const hers = mine(await listAnnouncementsForCustomer(her.id))
  assert.ok(hers.some((a) => a.title === `${TAG} loose`))
})

// A notice must never be the reason a shipment fails.
test("a handle nobody owns writes nothing and throws nothing", async () => {
  await notifyCustomer(`${TAG}_ghost`, { title: `${TAG} nowhere`, body: "x" })
  const [{ n }] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM announcements WHERE title = ${`${TAG} nowhere`}`
  assert.equal(Number(n), 0)
})

test("the shop's own screen does not show the automatic notices", async () => {
  const her = await named()
  await notifyCustomer(her.handle, { title: `${TAG} auto`, body: "x" })
  await createAnnouncement({ title: `${TAG} written`, body: "x" })
  const staff = mine(await listAnnouncements()).map((a) => a.title)
  assert.ok(staff.includes(`${TAG} written`))
  assert.ok(!staff.includes(`${TAG} auto`), "generated notices would bury the written ones")
})

// Marking read used to insert a row for every announcement in the table.
test("marking the inbox read does not touch another customer's notices", async () => {
  const her = await named()
  const other = await customer()
  await notifyCustomer(her.handle, { title: `${TAG} private`, body: "x" })

  await markAnnouncementsRead(other)

  const [row] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM announcement_reads r
      JOIN announcements a ON a.id = r.announcement_id
     WHERE a.title = ${`${TAG} private`} AND r.customer_id = ${other}`
  assert.equal(Number(row.n), 0, "a read row for a notice she cannot see")
})
