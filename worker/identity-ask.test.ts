import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../lib/db-pool"
import {
  parseHandle, hasBeenAsked, recordAsk, pendingAsk, answerAsk, findCustomerByNumber,
} from "../lib/whatsapp/identity"

const HANDLE = `asktest${process.hrtime.bigint()}`
const NUMBER = "6281700000001"
const UNKNOWN = "6281700000002"

before(async () => {
  await sql`INSERT INTO customers (instagram_id) VALUES (${HANDLE}) ON CONFLICT DO NOTHING`
})

after(async () => {
  await sql`DELETE FROM wa_identity_asks WHERE number IN (${NUMBER}, ${UNKNOWN})`
  await sql`DELETE FROM customers WHERE instagram_id = ${HANDLE}`
  await sql.end()
})

test("a bare handle is recognised however it is written", () => {
  assert.equal(parseHandle("nadia.putri"), "nadia.putri")
  assert.equal(parseHandle("@Nadia.Putri"), "nadia.putri")
  assert.equal(parseHandle("  @nadia_putri  "), "nadia_putri")
})

test("ordinary chatter is never mistaken for a username", () => {
  // This runs on whatever the customer types next, so a false positive attaches
  // somebody's orders to a stranger.
  assert.equal(parseHandle("iya kak"), null)
  assert.equal(parseHandle("mau yg 95"), null)
  assert.equal(parseHandle(""), null)
  assert.equal(parseHandle("nadia putri"), null, "a space means it is a sentence")
  assert.equal(parseHandle("95"), null, "a bare number is a size, not a username")
  assert.equal(parseHandle("a"), null, "too short to be anyone")
})

test("the question is asked once and only once", async () => {
  assert.equal(await hasBeenAsked(NUMBER), false)
  await recordAsk(NUMBER, "q1")
  assert.equal(await hasBeenAsked(NUMBER), true)

  // A second claim from the same person must not ask again.
  await recordAsk(NUMBER, "q2")
  const ask = await pendingAsk(NUMBER)
  assert.equal(ask?.messageId, "q1", "the original question stands")
})

test("answering links the number and closes the question", async () => {
  await recordAsk(NUMBER, "q1")
  assert.equal(await answerAsk(NUMBER, HANDLE), true)

  assert.equal(await findCustomerByNumber(NUMBER), HANDLE)
  assert.equal(await pendingAsk(NUMBER), null, "answered, so never asked again")
})

test("a handle nobody has is refused rather than created", async () => {
  await recordAsk(UNKNOWN, "q1")
  assert.equal(await answerAsk(UNKNOWN, "someone-who-does-not-exist"), false)

  const [count] = await sql`
    SELECT COUNT(*)::int AS n FROM customers WHERE instagram_id = 'someone-who-does-not-exist'
  `
  assert.equal(count.n, 0, "a typo must not invent a customer nobody can find again")
  assert.ok(await pendingAsk(UNKNOWN), "still outstanding, so they can try again")
})
