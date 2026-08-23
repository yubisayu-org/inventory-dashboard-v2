import { test, after } from "node:test"
import assert from "node:assert/strict"
import postgres from "postgres"
import sql from "../db-pool"

// The grants the public access-request path actually needs.
//
// These run as catalogue_public rather than the owner, because a grant is the
// one thing an owner-connection test can never check: everything passes when
// you are allowed to do everything. Asking for access was broken in exactly
// this way — INSERT granted, the guard's SELECT not — and every stranger's
// first contact with the shop came back a 500.

const TAG = `grantstest${process.hrtime.bigint()}`
const url = process.env.CATALOGUE_PUBLIC_DATABASE_URL

const publicSql = url
  ? postgres(url, { ssl: /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) ? false : "require", prepare: false })
  : null

after(async () => {
  await sql`DELETE FROM catalogue_access_requests WHERE instagram_id LIKE ${`${TAG}%`}`
  await publicSql?.end()
  await sql.end()
})

test("a stranger can ask for access, guard and all", { skip: !publicSql }, async () => {
  const handle = `${TAG}_asks`
  // The route's own statement, verbatim: the INSERT reads the table to avoid
  // burying the staff queue under one person asking twice.
  await publicSql!`
    INSERT INTO catalogue_access_requests (instagram_id, note)
    SELECT ${handle}, 'please'
     WHERE NOT EXISTS (
       SELECT 1 FROM catalogue_access_requests
        WHERE instagram_id = ${handle} AND status = 'pending'
     )
  `
  const [row] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM catalogue_access_requests WHERE instagram_id = ${handle}`
  assert.equal(Number(row.n), 1)
})

test("asking twice leaves one row, not two", { skip: !publicSql }, async () => {
  const handle = `${TAG}_asks`
  await publicSql!`
    INSERT INTO catalogue_access_requests (instagram_id, note)
    SELECT ${handle}, 'again'
     WHERE NOT EXISTS (
       SELECT 1 FROM catalogue_access_requests
        WHERE instagram_id = ${handle} AND status = 'pending'
     )
  `
  const [row] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM catalogue_access_requests WHERE instagram_id = ${handle}`
  assert.equal(Number(row.n), 1, "the guard did its job")
})

// The guard needs two columns. It does not need what anyone wrote.
test("what somebody else wrote stays unreadable from the public path", { skip: !publicSql }, async () => {
  await assert.rejects(
    () => publicSql!`SELECT note FROM catalogue_access_requests LIMIT 1`,
    /permission denied/,
  )
})

test("and the queue cannot be emptied from outside", { skip: !publicSql }, async () => {
  await assert.rejects(
    () => publicSql!`DELETE FROM catalogue_access_requests WHERE instagram_id = ${TAG}`,
    /permission denied/,
  )
  await assert.rejects(
    () => publicSql!`UPDATE catalogue_access_requests SET status = 'approved'`,
    /permission denied/,
  )
})
