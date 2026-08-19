# WhatsApp Product Posts — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer claim an already-catalogued product from a WhatsApp
post by a short code (or, for products that already carry a store code like
`2099A1`, by that code directly), route the claim through the existing
`catalogue_requests` inbox, and let the owner approve it into an ordinary
order — all on the schema and worker process, with no dashboard UI yet.

**Architecture:** Migration 075 adds `wa_sends`/`wa_send_codes` (one row per
trip a `catalogue_posts` row is sent to, and one row per coded product on
that send) plus a small `wa_replies` queue, and extends `catalogue_requests`
with a `source` column, an `asking` status, and the WhatsApp-only fields. A
new data layer (`lib/db/wa-sends.ts`, extensions to `lib/db/catalogue-requests.ts`
and `lib/db/outbox.ts`) sits under new worker logic
(`worker/product-post.ts`, `worker/product-post-offer.ts`) that mirrors the
already-shipped `wa_size_offers` pattern (`worker/size-offer.ts`) closely
enough to reuse its shape task-for-task.

**Tech Stack:** TypeScript, Next.js (API routes only, no UI in this plan),
`postgres` (the `postgres` npm package, not an ORM), Baileys (WhatsApp),
`node:test` + `tsx` against a real local Postgres.

**Spec:** `docs/superpowers/specs/2026-08-19-whatsapp-product-post-design.md`

## Global Constraints

- Code alphabet: `"ABCDEFGHJKLMNPQRTUVWXYZ"` (I, O, S excluded; Q included) —
  copy this exact string, do not re-derive it.
- Codes are one letter + two digits (`A01`–`Z99`), unique per `(event, code)`,
  never reused within a trip even after a gap, computed as "the code after
  the current max issued for this event" — not a separate sequence table.
- Every DB-touching function in this plan takes an optional
  `db: DBExecutor = sql` last parameter (see `lib/db/actor.ts`'s
  `DBExecutor` type, already used throughout `lib/db/catalog.ts` and
  `lib/db/claims.ts`) **except** where the spec requires a specific
  `postgres.Sql` connection scoped to a role — this plan has no such case,
  every function here runs under the worker's or the dashboard's full-
  privilege connection.
- All new tables/columns match the exact SQL in the spec's "Data model —
  migration 075" section verbatim — do not improvise column names or types.
- Test convention (matches `worker/size-offer.test.ts`,
  `lib/whatsapp/swap.test.ts` exactly): `node:test` + `assert/strict` against
  the real local Postgres via `sql` from `@/lib/db-pool` — no mocking. Each
  test file seeds a uniquely-named `events` row (`` `TEST<TAG>${process.hrtime.bigint()}` ``)
  and a uniquely-named group JID (`` `${process.hrtime.bigint()}@g.us` ``) in
  `before()`, and deletes everything scoped to that event/JID in `after()`,
  ending with `await sql.end()`.
- Run the full suite with `npm test` (already globs `worker/*.test.ts`,
  `lib/**/*.test.ts` — no config changes needed).
- Local dev DB: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`,
  applied manually via `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/migrations/075_wa_product_posts.sql` —
  never `supabase db reset`.

---

## Task 1: Migration 075 — schema

**Files:**
- Create: `supabase/migrations/075_wa_product_posts.sql`

**Interfaces:**
- Produces: tables `wa_sends`, `wa_send_codes`, `wa_replies`; columns
  `catalogue_requests.source/send_id/send_code_id/sender/message_id/bot_message_id/candidate_send_code_ids`;
  `wa_outbox.send_id/caption` (already-nullable `post_id`). Every later task
  in this plan depends on this schema existing in the local dev DB.

- [ ] **Step 1: Write the migration**

```sql
-- WhatsApp product posts: claim an already-catalogued product by a short
-- code (or, for a product whose name already starts with a store code, by
-- that code directly). Builds on catalogue_posts/catalogue_requests
-- (migration 058, extended by 076/079) instead of duplicating them — see
-- docs/superpowers/specs/2026-08-19-whatsapp-product-post-design.md.

-- One trip a catalogue post is sent to. A repost of the same post to a
-- later trip is a second row here, not a new catalogue_posts row.
CREATE TABLE wa_sends (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES catalogue_posts(id) ON DELETE CASCADE,
  event      TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  group_jid  TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX idx_wa_sends_post ON wa_sends (post_id);
CREATE INDEX idx_wa_sends_event ON wa_sends (event);
CREATE INDEX idx_wa_sends_message ON wa_sends (message_id) WHERE message_id <> '';

-- One coded line of a send: a tagged product, its code, and the price it
-- was posted at.
CREATE TABLE wa_send_codes (
  id         SERIAL PRIMARY KEY,
  send_id    INTEGER NOT NULL REFERENCES wa_sends(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  code       TEXT NOT NULL,
  event      TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE,
  price      NUMERIC(14,2) NOT NULL,
  point_x    DOUBLE PRECISION,
  point_y    DOUBLE PRECISION,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wa_send_codes_send ON wa_send_codes (send_id);
CREATE UNIQUE INDEX idx_wa_send_codes_code ON wa_send_codes (event, code);

-- What a dashboard action needs the worker to say or react in the group —
-- Setuju/Tolak reactions, and the ❔ closing line when the owner resolves an
-- asking row first. The dashboard has no socket; the worker drains this on
-- a timer, the same shape as wa_outbox.
CREATE TABLE wa_replies (
  id                 SERIAL PRIMARY KEY,
  group_jid          TEXT NOT NULL,
  quoted_message_id  TEXT NOT NULL DEFAULT '',
  reaction           TEXT NOT NULL DEFAULT '',
  text               TEXT NOT NULL DEFAULT '',
  state              TEXT NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'sent', 'failed')),
  error              TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at            TIMESTAMPTZ
);
ALTER TABLE wa_replies ADD CONSTRAINT wa_replies_one_kind
  CHECK ((reaction <> '') <> (text <> ''));
CREATE INDEX idx_wa_replies_pending ON wa_replies (id) WHERE state = 'pending';

-- catalogue_requests becomes the one inbox for both a public-catalogue
-- request and a WhatsApp claim. product_id is ALREADY nullable and status
-- ALREADY carries offer_pending/approved (076_custom_catalogue_requests.sql,
-- 079_custom_request_edit_approval.sql) — this extends that real shape,
-- confirmed against the local dev DB, not the branch's original base shape.
ALTER TABLE catalogue_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'catalogue'
  CHECK (source IN ('catalogue', 'whatsapp'));

ALTER TABLE catalogue_requests ADD COLUMN send_id INTEGER
  REFERENCES wa_sends(id) ON DELETE CASCADE;
ALTER TABLE catalogue_requests ADD COLUMN send_code_id INTEGER
  REFERENCES wa_send_codes(id) ON DELETE SET NULL;
ALTER TABLE catalogue_requests ADD COLUMN sender TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogue_requests ADD COLUMN message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogue_requests ADD COLUMN bot_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogue_requests ADD COLUMN candidate_send_code_ids INTEGER[];

ALTER TABLE catalogue_requests DROP CONSTRAINT catalogue_requests_status_check;
ALTER TABLE catalogue_requests ADD CONSTRAINT catalogue_requests_status_check
  CHECK (status IN ('pending', 'offer_pending', 'approved', 'asking', 'converted', 'rejected'));

ALTER TABLE catalogue_requests DROP CONSTRAINT catalogue_requests_product_or_description;
ALTER TABLE catalogue_requests ADD CONSTRAINT catalogue_requests_product_or_description
  CHECK (product_id IS NOT NULL OR description <> '' OR status = 'asking');

CREATE INDEX idx_catalogue_requests_send ON catalogue_requests (send_id);
CREATE INDEX idx_catalogue_requests_asking
  ON catalogue_requests (id) WHERE status = 'asking';

-- wa_outbox: a send's photo+caption reuses the shelf queue, not a new table.
ALTER TABLE wa_outbox ALTER COLUMN post_id DROP NOT NULL;
ALTER TABLE wa_outbox ADD COLUMN send_id INTEGER
  REFERENCES wa_sends(id) ON DELETE CASCADE;
ALTER TABLE wa_outbox ADD CONSTRAINT wa_outbox_one_target
  CHECK ((post_id IS NULL) <> (send_id IS NULL));
ALTER TABLE wa_outbox ADD COLUMN caption TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_wa_outbox_send
  ON wa_outbox (send_id) WHERE send_id IS NOT NULL;
```

- [ ] **Step 2: Apply it to the local dev DB**

Run: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/migrations/075_wa_product_posts.sql`
Expected: every statement prints `CREATE TABLE`/`ALTER TABLE`/`CREATE INDEX` with no error.

- [ ] **Step 3: Verify the shape**

Run: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d wa_sends" -c "\d wa_send_codes" -c "\d wa_replies" -c "\d catalogue_requests"`
Expected: `wa_sends`/`wa_send_codes`/`wa_replies` show the columns above;
`catalogue_requests` shows the seven new columns and a `status` CHECK
listing all six values (`pending, offer_pending, approved, asking,
converted, rejected`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/075_wa_product_posts.sql
git commit -m "feat(wa-sends): migration 075 — wa_sends, wa_send_codes, wa_replies, catalogue_requests extensions"
```

---

## Task 2: `lib/whatsapp/codes.ts` — the alphabet, code allocation, and parsing

**Files:**
- Create: `lib/whatsapp/codes.ts`
- Test: `lib/whatsapp/codes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CODE_LETTERS: string
  export function nextCode(usedCodes: string[]): string
  export function parseCodes(text: string): string[]
  ```
  Later tasks (`lib/db/wa-sends.ts`'s `attachProductToSend`,
  `worker/product-post.ts`'s resolution) call both `nextCode` and
  `parseCodes` exactly as declared above — no DB access in this file.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { CODE_LETTERS, nextCode, parseCodes } from "./codes"

test("the alphabet excludes I, O, S and includes Q", () => {
  assert.equal(CODE_LETTERS.includes("I"), false)
  assert.equal(CODE_LETTERS.includes("O"), false)
  assert.equal(CODE_LETTERS.includes("S"), false)
  assert.equal(CODE_LETTERS.includes("Q"), true)
  assert.equal(CODE_LETTERS.length, 23)
})

test("nextCode starts a fresh event at A01", () => {
  assert.equal(nextCode([]), "A01")
})

test("nextCode continues the highest issued code", () => {
  assert.equal(nextCode(["A01", "A02"]), "A03")
})

test("nextCode does not backfill a gap left by a middle removal", () => {
  // K41, K42, K43 issued; K42 removed. Next is K44, not K42.
  assert.equal(nextCode(["A41", "A43"]), "A44")
})

test("A99 rolls to B01", () => {
  assert.equal(nextCode(["A99"]), "B01")
})

test("nextCode throws once the alphabet is exhausted", () => {
  assert.throws(() => nextCode(["Z99"]), /exhausted/)
})

test("parseCodes finds a code in ordinary claim text", () => {
  assert.deepEqual(parseCodes("K42 mau 1"), ["K42"])
  assert.deepEqual(parseCodes("mau K41 dua ya kak"), ["K41"])
})

test("parseCodes rejects a bare number and a size-like token", () => {
  assert.deepEqual(parseCodes("100 aja kak"), [])
  assert.deepEqual(parseCodes("ukuran 38L ya"), [])
})

test("parseCodes rejects a letter outside the alphabet", () => {
  assert.deepEqual(parseCodes("I42 mau 1"), [])
  assert.deepEqual(parseCodes("O10 mau 1"), [])
})

test("parseCodes finds every distinct code in a multi-code message", () => {
  assert.deepEqual(parseCodes("K41 sama K42 masing-masing 1"), ["K41", "K42"])
})

test("parseCodes is case-insensitive and normalizes to uppercase", () => {
  assert.deepEqual(parseCodes("k42 mau 1"), ["K42"])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test lib/whatsapp/codes.test.ts`
Expected: FAIL — `codes.ts` does not exist yet.

- [ ] **Step 3: Implement**

```ts
/** Letters a code can start with. I, O and S are dropped: they read as 1, 0, 5. */
export const CODE_LETTERS = "ABCDEFGHJKLMNPQRTUVWXYZ"

const CODE_PATTERN = new RegExp(`\\b([${CODE_LETTERS}])(\\d{2})\\b`, "gi")

/**
 * The code after the highest one in `usedCodes`, within one event.
 *
 * Not "the first unused code": removing a middle code during composing must
 * not have the next attach reuse it (see the spec's "Codes" section) — only
 * the last-ever-issued code matters, so this is a max-plus-one, not a scan
 * for a gap.
 */
export function nextCode(usedCodes: string[]): string {
  if (usedCodes.length === 0) return `${CODE_LETTERS[0]}01`

  let maxLetterIndex = 0
  let maxDigit = 0
  for (const code of usedCodes) {
    const letter = code[0]
    const digit = Number.parseInt(code.slice(1), 10)
    const letterIndex = CODE_LETTERS.indexOf(letter)
    if (letterIndex > maxLetterIndex || (letterIndex === maxLetterIndex && digit > maxDigit)) {
      maxLetterIndex = letterIndex
      maxDigit = digit
    }
  }

  if (maxDigit < 99) return `${CODE_LETTERS[maxLetterIndex]}${String(maxDigit + 1).padStart(2, "0")}`

  const nextLetterIndex = maxLetterIndex + 1
  if (nextLetterIndex >= CODE_LETTERS.length) {
    throw new Error("code alphabet exhausted for this event — 2 277 codes issued")
  }
  return `${CODE_LETTERS[nextLetterIndex]}01`
}

/** Every code-shaped token in `text`, uppercased, in the order they appear. */
export function parseCodes(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(CODE_PATTERN)) {
    found.push(`${match[1].toUpperCase()}${match[2]}`)
  }
  return found
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsx --test lib/whatsapp/codes.test.ts`
Expected: PASS, all 11 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/whatsapp/codes.ts lib/whatsapp/codes.test.ts
git commit -m "feat(wa-sends): code alphabet, allocation, and parsing"
```

---

## Task 3: `lib/db/wa-sends.ts` — the data layer

**Files:**
- Create: `lib/db/wa-sends.ts`
- Test: `lib/db/wa-sends.test.ts`

**Interfaces:**
- Consumes: `nextCode` from `lib/whatsapp/codes.ts` (Task 2); `DBExecutor`
  type from `lib/db/actor.ts` (existing).
- Produces:
  ```ts
  export interface WaSend {
    id: number; postId: number; event: string; title: string
    messageId: string; groupJid: string; createdAt: string
  }
  export interface WaSendCode {
    id: number; sendId: number; productId: number; productName: string
    code: string; event: string; price: number
    pointX: number | null; pointY: number | null; position: number
  }
  export async function createSend(input: { postId: number; event: string; title: string }, db?: DBExecutor): Promise<{ id: number }>
  export async function getSend(id: number, db?: DBExecutor): Promise<WaSend | null>
  export async function listSendCodes(sendId: number, db?: DBExecutor): Promise<WaSendCode[]>
  export async function attachProductToSend(sendId: number, productId: number, db?: DBExecutor): Promise<WaSendCode>
  export async function getSendCodeByCode(event: string, code: string, db?: DBExecutor): Promise<WaSendCode | null>
  export async function getOpenSendForGroup(groupJid: string, db?: DBExecutor): Promise<WaSend | null>
  export async function getSendByMessage(groupJid: string, messageId: string, db?: DBExecutor): Promise<WaSend | null>
  export async function setSendMessageId(id: number, messageId: string, groupJid: string, db?: DBExecutor): Promise<void>
  ```
  Task 4 (outbox), Task 6 (catalogue-requests extensions), Task 8/9 (worker
  resolution) all call these exact functions.

- [ ] **Step 1: Write the failing tests**

```ts
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import {
  createSend, getSend, listSendCodes, attachProductToSend,
  getSendCodeByCode, getOpenSendForGroup, getSendByMessage, setSendMessageId,
} from "./wa-sends"

const EVENT = `TESTSEND${process.hrtime.bigint()}`
const GROUP = `${process.hrtime.bigint()}@g.us`
let postId: number
let productAId: number
let productBId: number

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  const [post] = await sql`
    INSERT INTO catalogue_posts (media_url, media_type) VALUES ('https://example.com/t.jpg', 'photo')
    RETURNING id
  `
  postId = post.id as number
  const [a] = await sql`INSERT INTO products (name, store, price) VALUES ('Test Bag A', 'ZHG', 100000) RETURNING id`
  const [b] = await sql`INSERT INTO products (name, store, price) VALUES ('Test Bag B', 'ZHG', 200000) RETURNING id`
  productAId = a.id as number
  productBId = b.id as number
})

after(async () => {
  await sql`DELETE FROM wa_sends WHERE event = ${EVENT}`
  await sql`DELETE FROM catalogue_post_products WHERE post_id = ${postId}`
  await sql`DELETE FROM catalogue_posts WHERE id = ${postId}`
  await sql`DELETE FROM products WHERE id IN (${productAId}, ${productBId})`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("creating a send and attaching two products issues sequential codes", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "MUJI restock" })

  const send = await getSend(sendId)
  assert.equal(send?.title, "MUJI restock")
  assert.equal(send?.event, EVENT)

  const codeA = await attachProductToSend(sendId, productAId)
  assert.equal(codeA.code, "A01")
  assert.equal(codeA.price, 100000)

  const codeB = await attachProductToSend(sendId, productBId)
  assert.equal(codeB.code, "A02")

  const codes = await listSendCodes(sendId)
  assert.equal(codes.length, 2)

  // Tagging the product on catalogue_post_products is a side effect of attaching.
  const [tag] = await sql`SELECT 1 FROM catalogue_post_products WHERE post_id = ${postId} AND product_id = ${productAId}`
  assert.ok(tag, "attaching a product tags it on the underlying post")
})

test("attaching an already-tagged product does not duplicate the tag", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "Repost" })
  await attachProductToSend(sendId, productAId)
  await attachProductToSend(sendId, productAId === productAId ? productBId : productAId) // second product, distinct code
  const [{ count }] = await sql`SELECT count(*)::int FROM catalogue_post_products WHERE post_id = ${postId} AND product_id = ${productAId}`
  assert.equal(count, 1)
})

test("getSendCodeByCode resolves within the right event only", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "t" })
  const issued = await attachProductToSend(sendId, productAId)

  const found = await getSendCodeByCode(EVENT, issued.code)
  assert.equal(found?.id, issued.id)

  const notFound = await getSendCodeByCode(`${EVENT}-other`, issued.code)
  assert.equal(notFound, null)
})

test("getOpenSendForGroup resolves via the group's bound event", async () => {
  await sql`
    INSERT INTO wa_groups (jid, event) VALUES (${GROUP}, ${EVENT})
    ON CONFLICT (jid) DO UPDATE SET event = EXCLUDED.event
  `
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "t" })
  await setSendMessageId(sendId, "msg-1", GROUP)

  const open = await getOpenSendForGroup(GROUP)
  assert.equal(open?.id, sendId)

  await sql`DELETE FROM wa_groups WHERE jid = ${GROUP}`
})

test("getOpenSendForGroup ignores a send that was never actually posted", async () => {
  await sql`
    INSERT INTO wa_groups (jid, event) VALUES (${GROUP}, ${EVENT})
    ON CONFLICT (jid) DO UPDATE SET event = EXCLUDED.event
  `
  await createSend({ postId, event: EVENT, title: "drafted, never sent" })
  const open = await getOpenSendForGroup(GROUP)
  assert.equal(open, null, "a draft with no message_id has not gone out yet")
  await sql`DELETE FROM wa_groups WHERE jid = ${GROUP}`
})

test("setSendMessageId records the message id and group", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "t" })
  await setSendMessageId(sendId, "msg-42", GROUP)
  const send = await getSend(sendId)
  assert.equal(send?.messageId, "msg-42")
  assert.equal(send?.groupJid, GROUP)
})

test("getSendByMessage resolves a quoted post back to its send", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "t" })
  await setSendMessageId(sendId, "msg-99", GROUP)
  const found = await getSendByMessage(GROUP, "msg-99")
  assert.equal(found?.id, sendId)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test lib/db/wa-sends.test.ts`
Expected: FAIL — `wa-sends.ts` does not exist yet.

- [ ] **Step 3: Implement**

```ts
import sql from "@/lib/db-pool"
import type { DBExecutor } from "./actor"
import { nextCode } from "@/lib/whatsapp/codes"

export interface WaSend {
  id: number
  postId: number
  event: string
  title: string
  messageId: string
  groupJid: string
  createdAt: string
}

export interface WaSendCode {
  id: number
  sendId: number
  productId: number
  productName: string
  code: string
  event: string
  price: number
  pointX: number | null
  pointY: number | null
  position: number
}

function toSend(row: Record<string, unknown>): WaSend {
  return {
    id: row.id as number,
    postId: row.post_id as number,
    event: row.event as string,
    title: row.title as string,
    messageId: row.message_id as string,
    groupJid: row.group_jid as string,
    createdAt: (row.created_at as Date).toISOString(),
  }
}

function toSendCode(row: Record<string, unknown>): WaSendCode {
  return {
    id: row.id as number,
    sendId: row.send_id as number,
    productId: row.product_id as number,
    productName: row.product_name as string,
    code: row.code as string,
    event: row.event as string,
    price: Number(row.price),
    pointX: row.point_x === null ? null : Number(row.point_x),
    pointY: row.point_y === null ? null : Number(row.point_y),
    position: row.position as number,
  }
}

export async function createSend(
  input: { postId: number; event: string; title: string },
  db: DBExecutor = sql,
): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO wa_sends (post_id, event, title)
    VALUES (${input.postId}, ${input.event}, ${input.title})
    RETURNING id
  `
  return { id: row.id as number }
}

export async function getSend(id: number, db: DBExecutor = sql): Promise<WaSend | null> {
  const [row] = await db`SELECT * FROM wa_sends WHERE id = ${id}`
  return row ? toSend(row) : null
}

export async function listSendCodes(sendId: number, db: DBExecutor = sql): Promise<WaSendCode[]> {
  const rows = await db`
    SELECT c.*, p.name AS product_name
    FROM wa_send_codes c JOIN products p ON p.id = c.product_id
    WHERE c.send_id = ${sendId}
    ORDER BY c.position, c.id
  `
  return rows.map(toSendCode)
}

/**
 * Tag a product onto the send's underlying post (if not already tagged) and
 * issue it the next free code for the send's event, snapshotting the
 * product's current price.
 */
export async function attachProductToSend(
  sendId: number,
  productId: number,
  db: DBExecutor = sql,
): Promise<WaSendCode> {
  return db.begin(async (tx) => {
    const [send] = await tx`SELECT post_id, event FROM wa_sends WHERE id = ${sendId}`
    if (!send) throw new Error("send not found")

    await tx`
      INSERT INTO catalogue_post_products (post_id, product_id)
      VALUES (${send.post_id}, ${productId})
      ON CONFLICT DO NOTHING
    `

    const [product] = await tx`SELECT name, price FROM products WHERE id = ${productId}`
    if (!product) throw new Error("product not found")

    const existing = await tx`SELECT code FROM wa_send_codes WHERE event = ${send.event}`
    const code = nextCode(existing.map((r) => r.code as string))

    const [position] = await tx`SELECT count(*)::int AS n FROM wa_send_codes WHERE send_id = ${sendId}`

    const [row] = await tx`
      INSERT INTO wa_send_codes (send_id, product_id, code, event, price, position)
      VALUES (${sendId}, ${productId}, ${code}, ${send.event}, ${product.price}, ${position.n})
      RETURNING *
    `
    return toSendCode({ ...row, product_name: product.name })
  })
}

export async function getSendCodeByCode(
  event: string,
  code: string,
  db: DBExecutor = sql,
): Promise<WaSendCode | null> {
  const [row] = await db`
    SELECT c.*, p.name AS product_name
    FROM wa_send_codes c JOIN products p ON p.id = c.product_id
    WHERE c.event = ${event} AND c.code = ${code}
  `
  return row ? toSendCode(row) : null
}

/**
 * The send bound to this group's currently-active trip, if it has actually
 * gone out (has a message_id). Mirrors the "unquoted → group's bound event"
 * half of the existing shelf resolution pattern in worker/capture.ts.
 */
export async function getOpenSendForGroup(groupJid: string, db: DBExecutor = sql): Promise<WaSend | null> {
  const [row] = await db`
    SELECT s.* FROM wa_sends s
    JOIN wa_groups g ON g.event = s.event
    WHERE g.jid = ${groupJid} AND s.message_id <> ''
    ORDER BY s.id DESC
    LIMIT 1
  `
  return row ? toSend(row) : null
}

export async function getSendByMessage(
  groupJid: string,
  messageId: string,
  db: DBExecutor = sql,
): Promise<WaSend | null> {
  const [row] = await db`
    SELECT * FROM wa_sends WHERE group_jid = ${groupJid} AND message_id = ${messageId}
  `
  return row ? toSend(row) : null
}

export async function setSendMessageId(
  id: number,
  messageId: string,
  groupJid: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE wa_sends SET message_id = ${messageId}, group_jid = ${groupJid}, updated_at = NOW()
    WHERE id = ${id}
  `
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsx --test lib/db/wa-sends.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/db/wa-sends.ts lib/db/wa-sends.test.ts
git commit -m "feat(wa-sends): data layer for sends and send codes"
```

---

## Task 4: Caption rendering + the send outbox

**Files:**
- Create: `lib/whatsapp/product-post.ts`
- Test: `lib/whatsapp/product-post.test.ts`
- Modify: `lib/db/outbox.ts` (add `queueSend`, `nextPendingSend`, `markSendSent`)
- Test: `lib/db/outbox.test.ts` (new file — none exists today)
- Modify: `worker/outbox.ts` (add `sendNextSend`)
- Modify: `worker/index.ts` (wire `sendNextSend` into the existing outbox interval, ~line 400)

**Interfaces:**
- Consumes: `WaSend`, `WaSendCode`, `getSend`, `listSendCodes` (Task 3).
- Produces:
  ```ts
  // lib/whatsapp/product-post.ts
  export function renderCaption(send: { title: string }, codes: { code: string; productName: string; price: number }[]): string

  // lib/db/outbox.ts additions
  export interface SendOutboxItem { id: number; sendId: number; groupJid: string; mediaUrl: string; caption: string }
  export async function queueSend(sendId: number, event: string, caption: string, db?: DBExecutor): Promise<boolean>
  export async function nextPendingSend(db?: DBExecutor): Promise<SendOutboxItem | null>
  export async function markSendSent(id: number, sendId: number, messageId: string, groupJid: string, db?: DBExecutor): Promise<void>

  // worker/outbox.ts additions
  export async function sendNextSend(sock: WASocket): Promise<boolean>
  ```
  The dashboard plan's "Kirim ke grup" route calls `queueSend`.

- [ ] **Step 1: Write the failing tests for caption rendering**

`lib/whatsapp/product-post.test.ts`:

```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { renderCaption } from "./product-post"

test("renders title, one line per code, and the reply instruction", () => {
  const caption = renderCaption(
    { title: "MUJI restock" },
    [
      { code: "K41", productName: "Boston Bag 38L Greige", price: 385000 },
      { code: "K42", productName: "Boston Bag 38L Black", price: 385000 },
    ],
  )
  assert.equal(
    caption,
    "📦 MUJI restock\n\n" +
    "K41 Boston Bag 38L Greige — Rp 385.000\n" +
    "K42 Boston Bag 38L Black — Rp 385.000\n\n" +
    "Reply kodenya ya, contoh: K42 mau 1",
  )
})

test("uses the first code in the example line, not always K42", () => {
  const caption = renderCaption({ title: "t" }, [{ code: "B07", productName: "Test", price: 1000 }])
  assert.ok(caption.includes("contoh: B07 mau 1"))
})

test("formats price with thousands separators, no decimals", () => {
  const caption = renderCaption({ title: "t" }, [{ code: "A01", productName: "Test", price: 1110000 }])
  assert.ok(caption.includes("Rp 1.110.000"))
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test lib/whatsapp/product-post.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `renderCaption`**

```ts
/**
 * The exact text a send goes out with. Generated, not typed — the composer's
 * live preview and the message wa_outbox actually sends must be identical,
 * so this is the one place that ever formats a caption.
 */
export function renderCaption(
  send: { title: string },
  codes: { code: string; productName: string; price: number }[],
): string {
  const lines = codes.map(
    (c) => `${c.code} ${c.productName} — Rp ${c.price.toLocaleString("id-ID")}`,
  )
  const example = codes[0]?.code ?? "K42"
  return [
    `📦 ${send.title}`,
    "",
    ...lines,
    "",
    `Reply kodenya ya, contoh: ${example} mau 1`,
  ].join("\n")
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsx --test lib/whatsapp/product-post.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Write the failing tests for the send outbox**

`lib/db/outbox.test.ts`:

```ts
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { createSend } from "./wa-sends"
import { queueSend, nextPendingSend, markSendSent } from "./outbox"

const EVENT = `TESTOUTBOX${process.hrtime.bigint()}`
const GROUP = `${process.hrtime.bigint()}@g.us`
let postId: number

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await sql`INSERT INTO wa_groups (jid, event, active) VALUES (${GROUP}, ${EVENT}, true) ON CONFLICT (jid) DO UPDATE SET event = EXCLUDED.event`
  const [post] = await sql`INSERT INTO catalogue_posts (media_url, media_type) VALUES ('https://example.com/t.jpg', 'photo') RETURNING id`
  postId = post.id as number
})

after(async () => {
  await sql`DELETE FROM wa_outbox WHERE send_id IN (SELECT id FROM wa_sends WHERE event = ${EVENT})`
  await sql`DELETE FROM wa_sends WHERE event = ${EVENT}`
  await sql`DELETE FROM catalogue_posts WHERE id = ${postId}`
  await sql`DELETE FROM wa_groups WHERE jid = ${GROUP}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("queueSend finds the group bound to the event and queues one row", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "t" })
  const queued = await queueSend(sendId, EVENT, "the caption")
  assert.equal(queued, true)

  const item = await nextPendingSend()
  assert.equal(item?.sendId, sendId)
  assert.equal(item?.groupJid, GROUP)
  assert.equal(item?.caption, "the caption")
  assert.equal(item?.mediaUrl, "https://example.com/t.jpg")
})

test("queueSend returns false when the trip has no bound group", async () => {
  const orphanEvent = `${EVENT}-orphan`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${orphanEvent}, id FROM warehouses ORDER BY id LIMIT 1`
  const { id: sendId } = await createSend({ postId, event: orphanEvent, title: "t" })
  const queued = await queueSend(sendId, orphanEvent, "caption")
  assert.equal(queued, false)
  await sql`DELETE FROM wa_sends WHERE id = ${sendId}`
  await sql`DELETE FROM events WHERE name = ${orphanEvent}`
})

test("re-queueing an already-queued send does not duplicate the row", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "t" })
  await queueSend(sendId, EVENT, "caption")
  await queueSend(sendId, EVENT, "caption")
  const [{ count }] = await sql`SELECT count(*)::int FROM wa_outbox WHERE send_id = ${sendId}`
  assert.equal(count, 1)
})

test("markSendSent records the message id on both the outbox row and the send", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "t" })
  await queueSend(sendId, EVENT, "caption")
  const item = await nextPendingSend()
  await markSendSent(item!.id, sendId, "msg-1", GROUP)

  const [outboxRow] = await sql`SELECT state, message_id FROM wa_outbox WHERE id = ${item!.id}`
  assert.equal(outboxRow.state, "sent")
  assert.equal(outboxRow.message_id, "msg-1")

  const [sendRow] = await sql`SELECT message_id, group_jid FROM wa_sends WHERE id = ${sendId}`
  assert.equal(sendRow.message_id, "msg-1")
  assert.equal(sendRow.group_jid, GROUP)
})

test("nextPendingSend skips a shelf row (post_id) and only returns send rows", async () => {
  // Sanity check that the shared table's two shapes don't cross-contaminate.
  const before = await nextPendingSend()
  assert.equal(before, null, "queue should be empty of sends at this point in the file")
})
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx tsx --test lib/db/outbox.test.ts`
Expected: FAIL — `queueSend`/`nextPendingSend`/`markSendSent` not exported yet.

- [ ] **Step 7: Extend `lib/db/outbox.ts`**

Add to the existing file (do not remove `queueShelfPost`/`nextPending`/`markSent`/`markFailed`):

```ts
export interface SendOutboxItem {
  id: number
  sendId: number
  groupJid: string
  mediaUrl: string
  caption: string
}

/** Ask the bot to post a composed send. Silently does nothing if the send's
 *  trip has no group bound to it, matching queueShelfPost's behaviour. */
export async function queueSend(
  sendId: number,
  event: string,
  caption: string,
): Promise<boolean> {
  const [group] = await sql`
    SELECT jid FROM wa_groups WHERE event = ${event} AND active ORDER BY created_at DESC LIMIT 1
  `
  if (!group) return false

  await sql`
    INSERT INTO wa_outbox (send_id, group_jid, caption) VALUES (${sendId}, ${group.jid}, ${caption})
    ON CONFLICT (send_id) WHERE send_id IS NOT NULL DO NOTHING
  `
  return true
}

/** The next composed send waiting to be posted, oldest first. */
export async function nextPendingSend(): Promise<SendOutboxItem | null> {
  const [row] = await sql`
    SELECT o.id, o.send_id, o.group_jid, o.caption, p.media_url
    FROM wa_outbox o
    JOIN wa_sends s ON s.id = o.send_id
    JOIN catalogue_posts p ON p.id = s.post_id
    WHERE o.state = 'pending' AND o.send_id IS NOT NULL
    ORDER BY o.id ASC
    LIMIT 1
  `
  if (!row) return null
  return {
    id: row.id as number,
    sendId: row.send_id as number,
    groupJid: row.group_jid as string,
    mediaUrl: row.media_url as string,
    caption: row.caption as string,
  }
}

/** Record that a send went out, and which message carried it. */
export async function markSendSent(id: number, sendId: number, messageId: string, groupJid: string) {
  await sql.begin(async (tx) => {
    await tx`UPDATE wa_outbox SET state = 'sent', message_id = ${messageId}, sent_at = NOW() WHERE id = ${id}`
    await tx`UPDATE wa_sends SET message_id = ${messageId}, group_jid = ${groupJid}, updated_at = NOW() WHERE id = ${sendId}`
  })
}
```

Note the `ON CONFLICT (send_id) WHERE send_id IS NOT NULL DO NOTHING` — this
matches the partial unique index `idx_wa_outbox_send` from migration 075
exactly (a plain `ON CONFLICT (send_id)` would not match a partial index).

- [ ] **Step 8: Run to verify they pass**

Run: `npx tsx --test lib/db/outbox.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 9: Extend `worker/outbox.ts`**

Add alongside the existing `sendNextShelf`:

```ts
import { nextPendingSend, markSendSent } from "@/lib/db/outbox"

/** Post one waiting composed send, if there is one. Same pacing contract as
 *  sendNextShelf — the caller loops while this returns true. */
export async function sendNextSend(sock: WASocket): Promise<boolean> {
  const item = await nextPendingSend()
  if (item === null) return false

  try {
    const sent = await sock.sendMessage(item.groupJid, { image: { url: item.mediaUrl }, caption: item.caption })
    const messageId = sent?.key?.id ?? ""
    if (!messageId) throw new Error("sent, but WhatsApp returned no message id")
    await markSendSent(item.id, item.sendId, messageId, item.groupJid)
    return true
  } catch (err) {
    console.error(`failed to post send ${item.sendId}:`, err)
    return true
  }
}
```

(There is no `markSendFailed` — a send that fails to post is rare enough,
and important enough, that silently marking it `failed` and moving on would
bury it; logging and returning `true` keeps the loop going without losing
the row's `pending` state, so it will be retried on the next sweep. If this
proves noisy in practice, add `markSendFailed` mirroring `markFailed` later
— not needed for this plan's scope.)

- [ ] **Step 10: Wire into `worker/index.ts`**

In the existing `import { sendNextShelf, OUTBOX_INTERVAL_MS } from "./outbox"`
line, add `sendNextSend`. In the `setInterval` block (~line 400), change:

```ts
const outbox = setInterval(async () => {
  try {
    while (await sendNextShelf(sock)) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    while (await sendNextSend(sock)) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
  } catch (err) {
    console.error("outbox sweep failed:", err)
  }
}, OUTBOX_INTERVAL_MS)
```

- [ ] **Step 11: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add lib/whatsapp/product-post.ts lib/whatsapp/product-post.test.ts lib/db/outbox.ts lib/db/outbox.test.ts worker/outbox.ts worker/index.ts
git commit -m "feat(wa-sends): caption rendering and the send outbox"
```

---

## Task 5: `lib/db/replies.ts` + `worker/replies.ts` — the dashboard-action queue

**Files:**
- Create: `lib/db/replies.ts`
- Test: `lib/db/replies.test.ts`
- Create: `worker/replies.ts`
- Modify: `worker/index.ts` (a second `setInterval`, alongside the outbox one)

**Interfaces:**
- Produces:
  ```ts
  // lib/db/replies.ts
  export interface ReplyItem { id: number; groupJid: string; quotedMessageId: string; reaction: string; text: string }
  export async function queueReaction(groupJid: string, quotedMessageId: string, reaction: string, db?: DBExecutor): Promise<void>
  export async function queueText(groupJid: string, quotedMessageId: string, text: string, db?: DBExecutor): Promise<void>
  export async function nextPendingReply(db?: DBExecutor): Promise<ReplyItem | null>
  export async function markReplySent(id: number, db?: DBExecutor): Promise<void>
  export async function markReplyFailed(id: number, reason: string, db?: DBExecutor): Promise<void>

  // worker/replies.ts
  export const REPLY_INTERVAL_MS: number
  export async function sendNextReply(sock: WASocket): Promise<boolean>
  ```
  Task 6/7 (catalogue-requests extensions, Setuju/Tolak) call `queueReaction`
  and `queueText`.

- [ ] **Step 1: Write the failing tests**

```ts
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { queueReaction, queueText, nextPendingReply, markReplySent, markReplyFailed } from "./replies"

const GROUP = `${process.hrtime.bigint()}@g.us`

after(async () => {
  await sql`DELETE FROM wa_replies WHERE group_jid = ${GROUP}`
  await sql.end()
})

test("queueReaction and nextPendingReply round-trip a reaction row", async () => {
  await queueReaction(GROUP, "msg-1", "✅")
  const item = await nextPendingReply()
  assert.equal(item?.groupJid, GROUP)
  assert.equal(item?.quotedMessageId, "msg-1")
  assert.equal(item?.reaction, "✅")
  assert.equal(item?.text, "")
  await markReplySent(item!.id)
})

test("queueText and nextPendingReply round-trip a text row", async () => {
  await queueText(GROUP, "msg-2", "Sudah dicatat ya kak — K42 ×1 ✅")
  const item = await nextPendingReply()
  assert.equal(item?.text, "Sudah dicatat ya kak — K42 ×1 ✅")
  assert.equal(item?.reaction, "")
  await markReplySent(item!.id)
})

test("nextPendingReply returns oldest-first", async () => {
  await queueText(GROUP, "msg-3", "first")
  await queueText(GROUP, "msg-4", "second")
  const first = await nextPendingReply()
  assert.equal(first?.text, "first")
  await markReplySent(first!.id)
  const second = await nextPendingReply()
  assert.equal(second?.text, "second")
  await markReplySent(second!.id)
})

test("markReplyFailed leaves the row out of the pending queue", async () => {
  await queueText(GROUP, "msg-5", "will fail")
  const item = await nextPendingReply()
  await markReplyFailed(item!.id, "network")
  const next = await nextPendingReply()
  assert.equal(next, null)
  const [row] = await sql`SELECT state, error FROM wa_replies WHERE id = ${item!.id}`
  assert.equal(row.state, "failed")
  assert.equal(row.error, "network")
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test lib/db/replies.test.ts`
Expected: FAIL — `replies.ts` does not exist.

- [ ] **Step 3: Implement `lib/db/replies.ts`**

```ts
import sql from "@/lib/db-pool"
import type { DBExecutor } from "./actor"

export interface ReplyItem {
  id: number
  groupJid: string
  quotedMessageId: string
  reaction: string
  text: string
}

export async function queueReaction(
  groupJid: string,
  quotedMessageId: string,
  reaction: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO wa_replies (group_jid, quoted_message_id, reaction)
    VALUES (${groupJid}, ${quotedMessageId}, ${reaction})
  `
}

export async function queueText(
  groupJid: string,
  quotedMessageId: string,
  text: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO wa_replies (group_jid, quoted_message_id, text)
    VALUES (${groupJid}, ${quotedMessageId}, ${text})
  `
}

export async function nextPendingReply(db: DBExecutor = sql): Promise<ReplyItem | null> {
  const [row] = await db`
    SELECT * FROM wa_replies WHERE state = 'pending' ORDER BY id ASC LIMIT 1
  `
  if (!row) return null
  return {
    id: row.id as number,
    groupJid: row.group_jid as string,
    quotedMessageId: row.quoted_message_id as string,
    reaction: row.reaction as string,
    text: row.text as string,
  }
}

export async function markReplySent(id: number, db: DBExecutor = sql): Promise<void> {
  await db`UPDATE wa_replies SET state = 'sent', sent_at = NOW() WHERE id = ${id}`
}

export async function markReplyFailed(id: number, reason: string, db: DBExecutor = sql): Promise<void> {
  await db`UPDATE wa_replies SET state = 'failed', error = ${reason.slice(0, 500)} WHERE id = ${id}`
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsx --test lib/db/replies.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Implement `worker/replies.ts`**

```ts
import type { WASocket } from "baileys"
import { nextPendingReply, markReplySent, markReplyFailed } from "@/lib/db/replies"

/** How often the worker looks for a dashboard action waiting to reach the group. */
export const REPLY_INTERVAL_MS = 3000

/**
 * Deliver one queued reaction or text reply, if there is one.
 *
 * Builds a synthetic WAMessageKey from the stored group/message id — the
 * same construction ReactionQueue already relies on for a live reaction, so
 * this is proven to work without the original WAMessage object in hand.
 */
export async function sendNextReply(sock: WASocket): Promise<boolean> {
  const item = await nextPendingReply()
  if (item === null) return false

  const key = { remoteJid: item.groupJid, id: item.quotedMessageId, fromMe: false }

  try {
    if (item.reaction) {
      await sock.sendMessage(item.groupJid, { react: { text: item.reaction, key } })
    } else {
      await sock.sendMessage(item.groupJid, { text: item.text }, { quoted: { key, message: {} } })
    }
    await markReplySent(item.id)
    return true
  } catch (err) {
    await markReplyFailed(item.id, (err as Error).message)
    console.error(`failed to send queued reply ${item.id}:`, err)
    return true
  }
}
```

- [ ] **Step 6: Wire into `worker/index.ts`**

Add the import next to the outbox one, and a second interval alongside the
existing `outbox` one (~line 400):

```ts
import { sendNextReply, REPLY_INTERVAL_MS } from "./replies"
// ...
const replies = setInterval(async () => {
  try {
    while (await sendNextReply(sock)) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
  } catch (err) {
    console.error("reply sweep failed:", err)
  }
}, REPLY_INTERVAL_MS)
sock.ev.on("connection.update", ({ connection }) => {
  if (connection === "close") clearInterval(replies)
})
```

(Add this `clearInterval(replies)` line inside the *existing*
`sock.ev.on("connection.update", ...)` handler, alongside the existing
`clearInterval(outbox)` — do not register a second `connection.update`
listener.)

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If Baileys' `quoted` type rejects the synthetic
`{ key, message: {} }` shape, check what type `quoted` actually expects in
`node_modules/baileys/lib/Types/Message.d.ts` and adjust the literal to
match — the `message: {}` stub may need to be `undefined` or omitted
depending on the installed Baileys version. This is worth a real end-to-end
check against a live WhatsApp connection once merged; if the quote fails to
render in practice, sending the text unquoted (drop the third argument
entirely) is an acceptable fallback — the message is still readable, just
without the visual link to her original text.

- [ ] **Step 8: Commit**

```bash
git add lib/db/replies.ts lib/db/replies.test.ts worker/replies.ts worker/index.ts
git commit -m "feat(wa-sends): queued reactions/replies for dashboard-triggered actions"
```

---

## Task 6: Extend `lib/db/catalogue-requests.ts` for WhatsApp claims

**Files:**
- Modify: `lib/db/catalogue-requests.ts`
- Test: `lib/db/catalogue-requests.test.ts` (new — none exists today; check
  first, since another task on this branch may have added one)

**Interfaces:**
- Consumes: `queueText` from `lib/db/replies.ts` (Task 5).
- Produces:
  ```ts
  export async function createDirectClaim(input: {
    customerHandle: string; productId: number; qty: number; note: string
    sendId: number; sendCodeId: number; sender: string; messageId: string
  }, db?: DBExecutor): Promise<{ id: number }>

  export async function createAskingRequest(input: {
    customerHandle: string; qty: number; note: string
    sendId: number; sender: string; messageId: string; botMessageId: string
    candidateSendCodeIds: number[]
  }, db?: DBExecutor): Promise<{ id: number }>

  export async function createRejectedClaim(input: {
    customerHandle: string; qty: number; note: string
    sendId: number; sender: string; messageId: string
  }, db?: DBExecutor): Promise<{ id: number }>

  export async function resolveAskingCandidate(
    id: number, sendCodeId: number, resolvedBy: "customer" | "owner", db?: DBExecutor
  ): Promise<void>

  export async function findRequestByBotMessage(botMessageId: string, db?: DBExecutor): Promise<CatalogueRequest | null>
  ```
  Task 8 calls `createDirectClaim` and `createRejectedClaim`. Task 9 calls
  `createAskingRequest`, `resolveAskingCandidate` (customer side), and
  `findRequestByBotMessage`. The dashboard plan's inbox route calls
  `resolveAskingCandidate` (owner side).

- [ ] **Step 1: Check for an existing test file, then write the failing tests**

Run: `ls lib/db/catalogue-requests.test.ts 2>/dev/null && echo EXISTS || echo MISSING`

If `EXISTS`, read the file first and add the tests below to it rather than
overwriting. If `MISSING`, create it fresh:

```ts
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { createSend, attachProductToSend } from "./wa-sends"
import {
  createDirectClaim, createAskingRequest, createRejectedClaim,
  resolveAskingCandidate, findRequestByBotMessage,
} from "./catalogue-requests"

const EVENT = `TESTWACR${process.hrtime.bigint()}`
let postId: number
let productId: number
let sendId: number
let sendCodeId: number

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  const [post] = await sql`INSERT INTO catalogue_posts (media_url, media_type) VALUES ('https://example.com/t.jpg', 'photo') RETURNING id`
  postId = post.id as number
  const [product] = await sql`INSERT INTO products (name, store, price) VALUES ('Test Product', 'ZHG', 100000) RETURNING id`
  productId = product.id as number
  const send = await createSend({ postId, event: EVENT, title: "t" })
  sendId = send.id
  const code = await attachProductToSend(sendId, productId)
  sendCodeId = code.id
})

after(async () => {
  await sql`DELETE FROM catalogue_requests WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_send_codes WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_sends WHERE id = ${sendId}`
  await sql`DELETE FROM catalogue_post_products WHERE post_id = ${postId}`
  await sql`DELETE FROM catalogue_posts WHERE id = ${postId}`
  await sql`DELETE FROM products WHERE id = ${productId}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("createDirectClaim writes a pending, whatsapp-sourced row", async () => {
  const { id } = await createDirectClaim({
    customerHandle: "628111111111", productId, qty: 1, note: "K42 mau 1",
    sendId, sendCodeId, sender: "628111111111", messageId: "her-1",
  })
  const [row] = await sql`SELECT * FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.source, "whatsapp")
  assert.equal(row.status, "pending")
  assert.equal(row.product_id, productId)
  assert.equal(row.send_code_id, sendCodeId)
})

test("createAskingRequest writes a null-product asking row with candidates", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628122222222", qty: 1, note: "yang hitam mau 1",
    sendId, sender: "628122222222", messageId: "her-2", botMessageId: "bot-1",
    candidateSendCodeIds: [sendCodeId],
  })
  const [row] = await sql`SELECT * FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "asking")
  assert.equal(row.product_id, null)
  assert.deepEqual(row.candidate_send_code_ids, [sendCodeId])
})

test("resolveAskingCandidate (customer side) moves the row to pending without queueing a reply", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628133333333", qty: 1, note: "t",
    sendId, sender: "628133333333", messageId: "her-3", botMessageId: "bot-2",
    candidateSendCodeIds: [sendCodeId],
  })
  await resolveAskingCandidate(id, sendCodeId, "customer")
  const [row] = await sql`SELECT status, product_id, send_code_id FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "pending")
  assert.equal(row.product_id, productId)
  assert.equal(row.send_code_id, sendCodeId)

  const [{ count }] = await sql`SELECT count(*)::int FROM wa_replies WHERE quoted_message_id = 'her-3'`
  assert.equal(count, 0, "the customer resolving her own offer needs no queued reply")
})

test("resolveAskingCandidate (owner side) queues the closing text quoting her message", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628144444444", qty: 1, note: "t",
    sendId, sender: "628144444444", messageId: "her-4", botMessageId: "bot-3",
    candidateSendCodeIds: [sendCodeId],
  })
  await resolveAskingCandidate(id, sendCodeId, "owner")
  const [row] = await sql`SELECT status FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "pending")

  const [reply] = await sql`SELECT text, quoted_message_id, group_jid FROM wa_replies WHERE quoted_message_id = 'her-4'`
  assert.ok(reply, "owner resolution must queue a reply since the dashboard has no socket")
  assert.ok(reply.text.includes("Sudah dicatat"))
})

test("resolveAskingCandidate is idempotent — a second call on an already-resolved row does nothing", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628155555555", qty: 1, note: "t",
    sendId, sender: "628155555555", messageId: "her-5", botMessageId: "bot-4",
    candidateSendCodeIds: [sendCodeId],
  })
  await resolveAskingCandidate(id, sendCodeId, "customer")
  await resolveAskingCandidate(id, sendCodeId, "owner")
  const [{ count }] = await sql`SELECT count(*)::int FROM wa_replies WHERE quoted_message_id = 'her-5'`
  assert.equal(count, 0, "second resolution must be a no-op, including no duplicate queued reply")
})

test("findRequestByBotMessage resolves an open asking row by the bot's own message id", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628166666666", qty: 1, note: "t",
    sendId, sender: "628166666666", messageId: "her-6", botMessageId: "bot-6",
    candidateSendCodeIds: [sendCodeId],
  })
  const found = await findRequestByBotMessage("bot-6")
  assert.equal(found?.id, id)
})

test("findRequestByBotMessage returns null once the row has resolved", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628177777777", qty: 1, note: "t",
    sendId, sender: "628177777777", messageId: "her-7", botMessageId: "bot-7",
    candidateSendCodeIds: [sendCodeId],
  })
  await resolveAskingCandidate(id, sendCodeId, "customer")
  const found = await findRequestByBotMessage("bot-7")
  assert.equal(found, null, "a 👍 arriving after resolution must find nothing to act on")
})

test("createRejectedClaim writes a rejected, whatsapp-sourced row with no product", async () => {
  const { id } = await createRejectedClaim({
    customerHandle: "628188888888", qty: 1, note: "A21 mau 1",
    sendId, sender: "628188888888", messageId: "her-8",
  })
  const [row] = await sql`SELECT status, product_id, staff_note FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "rejected")
  assert.equal(row.product_id, null)
  assert.equal(row.staff_note, "trip sudah tutup")
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test lib/db/catalogue-requests.test.ts`
Expected: FAIL — the four new functions are not exported yet.

- [ ] **Step 3: Read the existing file, then add the new functions**

Read `lib/db/catalogue-requests.ts` in full first — it already has
`createCatalogueRequest`, `convertCatalogueRequest`, `rejectCatalogueRequest`,
and (from `custom-order-requests`) `editCatalogueRequest`,
`approveCatalogueRequestOffer`, etc. Add the following alongside them,
matching the file's existing `toCatalogueRequest`-style row-mapper and
`DBExecutor = sql` default-parameter convention exactly:

```ts
import { queueText } from "./replies"

export async function createDirectClaim(
  input: {
    customerHandle: string; productId: number; qty: number; note: string
    sendId: number; sendCodeId: number; sender: string; messageId: string
  },
  db: DBExecutor = sql,
): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO catalogue_requests
      (customer_handle, product_id, qty, note, source, send_id, send_code_id, sender, message_id, status)
    VALUES
      (${input.customerHandle}, ${input.productId}, ${input.qty}, ${input.note},
       'whatsapp', ${input.sendId}, ${input.sendCodeId}, ${input.sender}, ${input.messageId}, 'pending')
    RETURNING id
  `
  return { id: row.id as number }
}

export async function createAskingRequest(
  input: {
    customerHandle: string; qty: number; note: string; sendId: number
    sender: string; messageId: string; botMessageId: string; candidateSendCodeIds: number[]
  },
  db: DBExecutor = sql,
): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO catalogue_requests
      (customer_handle, qty, note, source, send_id, sender, message_id, bot_message_id,
       candidate_send_code_ids, status)
    VALUES
      (${input.customerHandle}, ${input.qty}, ${input.note}, 'whatsapp', ${input.sendId},
       ${input.sender}, ${input.messageId}, ${input.botMessageId},
       ${input.candidateSendCodeIds}, 'asking')
    RETURNING id
  `
  return { id: row.id as number }
}

/** Written when a send's event is not the group's currently-bound one — she
 *  quoted (or landed on, unquoted) a trip that has already closed. */
export async function createRejectedClaim(
  input: { customerHandle: string; qty: number; note: string; sendId: number; sender: string; messageId: string },
  db: DBExecutor = sql,
): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO catalogue_requests
      (customer_handle, qty, note, source, send_id, sender, message_id, status, staff_note)
    VALUES
      (${input.customerHandle}, ${input.qty}, ${input.note}, 'whatsapp', ${input.sendId},
       ${input.sender}, ${input.messageId}, 'rejected', 'trip sudah tutup')
    RETURNING id
  `
  return { id: row.id as number }
}

/**
 * Settle an 'asking' row onto one of its candidates. Guarded on
 * `status = 'asking'` so a second call — her 👍 arriving after the owner
 * already picked, or vice versa — is a no-op, which is what makes both
 * sides of the ❔ question safely idempotent.
 *
 * `resolvedBy: "owner"` additionally queues the closing group message,
 * because a dashboard action has no socket of its own (see
 * "Delivering a dashboard action to the group" in the spec). The customer
 * side never queues one — she is either already looking at the bot's live
 * reply, or the worker sends it inline in the same pass that called this.
 */
export async function resolveAskingCandidate(
  id: number,
  sendCodeId: number,
  resolvedBy: "customer" | "owner",
  db: DBExecutor = sql,
): Promise<void> {
  const [resolved] = await db`
    UPDATE catalogue_requests
    SET product_id = (SELECT product_id FROM wa_send_codes WHERE id = ${sendCodeId}),
        send_code_id = ${sendCodeId},
        status = 'pending',
        updated_at = NOW()
    WHERE id = ${id} AND status = 'asking'
    RETURNING message_id, qty
  `
  if (!resolved) return
  if (resolvedBy !== "owner") return

  const [send] = await db`
    SELECT s.group_jid, sc.code
    FROM wa_sends s JOIN wa_send_codes sc ON sc.id = ${sendCodeId}
    WHERE s.id = sc.send_id
  `
  await queueText(
    send.group_jid as string,
    resolved.message_id as string,
    `Sudah dicatat ya kak — ${send.code} ×${resolved.qty} ✅`,
    db,
  )
}

export async function findRequestByBotMessage(
  botMessageId: string,
  db: DBExecutor = sql,
): Promise<CatalogueRequest | null> {
  const [row] = await db`
    SELECT * FROM catalogue_requests WHERE bot_message_id = ${botMessageId} AND status = 'asking'
  `
  return row ? toCatalogueRequest(row) : null
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsx --test lib/db/catalogue-requests.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/db/catalogue-requests.ts lib/db/catalogue-requests.test.ts
git commit -m "feat(wa-sends): direct claims, asking rows, and candidate resolution"
```

---

## Task 7: Extend `convertCatalogueRequest`/`rejectCatalogueRequest` for WhatsApp rows

**Files:**
- Modify: `lib/db/catalogue-requests.ts` (the existing `convertCatalogueRequest`, `rejectCatalogueRequest`)
- Modify: `lib/db/catalogue-requests.test.ts`

**Interfaces:**
- Consumes: `queueReaction` from `lib/db/replies.ts` (Task 5).
- Produces: no new exports — `convertCatalogueRequest`/`rejectCatalogueRequest`
  keep their exact existing signatures from the research (`convertCatalogueRequest(id, event, actor, productIdOverride?)`,
  `rejectCatalogueRequest(id, staffNote, db?)`); their *behavior* extends to
  a `source = 'whatsapp'` row.

- [ ] **Step 1: Write the failing tests**

Add to `lib/db/catalogue-requests.test.ts`:

```ts
import { convertCatalogueRequest, rejectCatalogueRequest } from "./catalogue-requests"

test("convertCatalogueRequest on a WhatsApp row uses the send's price and event, and queues a ✅", async () => {
  const { id } = await createDirectClaim({
    customerHandle: "628188888888", productId, qty: 2, note: "t",
    sendId, sendCodeId, sender: "628188888888", messageId: "her-8",
  })
  // convertCatalogueRequest requires a resolvable customer — createDirectClaim's
  // customerHandle is a raw number, matching a real order's self-healing
  // customers row (see appendOrders); no separate customer setup needed here.
  const { orderId } = await convertCatalogueRequest(id, EVENT, "test@owner")

  const [order] = await sql`SELECT unit_price, unit, event FROM orders WHERE id = ${orderId}`
  assert.equal(Number(order.unit_price), 100000)
  assert.equal(order.unit, 2)
  assert.equal(order.event, EVENT)

  const [reply] = await sql`SELECT reaction FROM wa_replies WHERE quoted_message_id = 'her-8'`
  assert.equal(reply?.reaction, "✅")
})

test("rejectCatalogueRequest on a WhatsApp row queues a ❌", async () => {
  const { id } = await createDirectClaim({
    customerHandle: "628199999999", productId, qty: 1, note: "t",
    sendId, sendCodeId, sender: "628199999999", messageId: "her-9",
  })
  await rejectCatalogueRequest(id, "out of stock")
  const [reply] = await sql`SELECT reaction FROM wa_replies WHERE quoted_message_id = 'her-9'`
  assert.equal(reply?.reaction, "❌")
})

test("rejectCatalogueRequest on a catalogue-web row still queues nothing (no message_id to react to)", async () => {
  await createCatalogueRequest({ customerHandle: "web_user", productId, qty: 1, note: "t" }, sql)
  const [{ id }] = await sql`SELECT id FROM catalogue_requests WHERE customer_handle = 'web_user'`
  const before = await sql`SELECT count(*)::int AS n FROM wa_replies`
  await rejectCatalogueRequest(id, "n/a")
  const after = await sql`SELECT count(*)::int AS n FROM wa_replies`
  assert.equal(after[0].n, before[0].n)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test lib/db/catalogue-requests.test.ts`
Expected: FAIL — the new assertions on `wa_replies` rows find nothing, since
the existing functions don't queue anything yet.

- [ ] **Step 3: Read the existing `convertCatalogueRequest` and `rejectCatalogueRequest` in full**

Read `lib/db/catalogue-requests.ts` end to end before editing — the
research already captured their signatures, but not their bodies, and this
task edits inside a transactional guarded-`UPDATE` you must not disturb.

- [ ] **Step 4: Extend `convertCatalogueRequest`**

After the existing `appendOrders` call and the `converted_order_id`/`status`
update (inside whatever transaction wraps them today), add:

```ts
if (row.source === "whatsapp" && row.message_id) {
  await queueReaction(row.group_jid, row.message_id, "✅", tx)
}
```

This needs `group_jid`, which lives on `wa_sends`, not on
`catalogue_requests` directly — join it in wherever the function already
reads the row's current data (it must read `product_id`/`send_code_id`/etc
to build the `appendOrders` call, so extend that same `SELECT` with
`LEFT JOIN wa_sends ON wa_sends.id = catalogue_requests.send_id` and select
`wa_sends.group_jid`). Use whatever transaction handle (`tx`) the function's
existing `sql.begin(...)` block already exposes — do not open a second one.

- [ ] **Step 5: Extend `rejectCatalogueRequest`** the same way, queueing `"❌"`
  instead of `"✅"`, guarded the same way (`source === "whatsapp" && message_id`).

- [ ] **Step 6: Run to verify they pass**

Run: `npx tsx --test lib/db/catalogue-requests.test.ts`
Expected: PASS, all tests in the file (10 total across Tasks 6 and 7).

- [ ] **Step 7: Run the full existing suite to check nothing else broke**

Run: `npm test`
Expected: all tests pass, including every pre-existing catalogue-web-only
test in this file (the `source === "whatsapp"` guard must make the new
queueing a no-op for every catalogue-web row, including ones without a
`send_id` at all).

- [ ] **Step 8: Commit**

```bash
git add lib/db/catalogue-requests.ts lib/db/catalogue-requests.test.ts
git commit -m "feat(wa-sends): Setuju/Tolak react in the group for WhatsApp-sourced rows"
```

---

## Task 8: `worker/product-post.ts` — resolving an incoming claim

**Files:**
- Create: `worker/product-post.ts`
- Test: `worker/product-post.test.ts`

**Interfaces:**
- Consumes: `parseCodes` (Task 2); `getOpenSendForGroup`, `getSendByMessage`,
  `getSendCodeByCode`, `listSendCodes`, `WaSend`, `WaSendCode` (Task 3);
  `createDirectClaim`, `createRejectedClaim` (Task 6); `parseQuantity` from
  `lib/claims/quantity.ts` (existing); `findCustomerByNumber` from
  `lib/whatsapp/identity.ts` (existing); `normalizeNumber` from
  `lib/db/whatsapp-groups.ts` (existing).
- Produces:
  ```ts
  export type ProductPostResolution =
    | { kind: "reacted"; emoji: string }
    | { kind: "needsDisambiguation"; send: WaSend; customerHandle: string; qty: number; note: string; candidates: WaSendCode[] }
    | { kind: "notApplicable" }

  export async function resolveProductPostClaim(input: {
    groupJid: string; messageId: string; sender: string; text: string; quoted: string
  }): Promise<ProductPostResolution>
  ```
  `"reacted"` covers the direct-claim (`📝`), unrecognised-code (`😢`), and
  closed-trip (`❌`) cases — this function fully handles and writes those
  itself. `"needsDisambiguation"` is handed to Task 9's `askDisambiguation`,
  which posts the ❔ question and writes the row — this function cannot do
  that itself, since it has no live socket to post with. `"notApplicable"`
  means the caller falls through to the existing shelf path. Task 10 wires
  this into `worker/index.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { createSend, attachProductToSend, setSendMessageId } from "@/lib/db/wa-sends"
import { resolveProductPostClaim } from "./product-post"

const EVENT = `TESTPPCLAIM${process.hrtime.bigint()}`
const GROUP = `${process.hrtime.bigint()}@g.us`
const HER = "628111111111"
let postId: number
let productAId: number
let productBId: number
let sendId: number
let codeA: string
let codeB: string

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await sql`INSERT INTO wa_groups (jid, event, active) VALUES (${GROUP}, ${EVENT}, true) ON CONFLICT (jid) DO UPDATE SET event = EXCLUDED.event`
  const [post] = await sql`INSERT INTO catalogue_posts (media_url, media_type) VALUES ('https://example.com/t.jpg', 'photo') RETURNING id`
  postId = post.id as number
  const [a] = await sql`INSERT INTO products (name, store, price) VALUES ('2099A1 - Buckle Shoulder Bag Brown', 'ZHG', 840000) RETURNING id`
  const [b] = await sql`INSERT INTO products (name, store, price) VALUES ('30213 - Rorojen Bag Brown', 'ZHG', 920000) RETURNING id`
  productAId = a.id as number
  productBId = b.id as number

  const send = await createSend({ postId, event: EVENT, title: "ZHG restock" })
  sendId = send.id
  codeA = (await attachProductToSend(sendId, productAId)).code
  codeB = (await attachProductToSend(sendId, productBId)).code
  await setSendMessageId(sendId, "post-msg-1", GROUP)
})

after(async () => {
  await sql`DELETE FROM catalogue_requests WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_send_codes WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_sends WHERE id = ${sendId}`
  await sql`DELETE FROM catalogue_post_products WHERE post_id = ${postId}`
  await sql`DELETE FROM catalogue_posts WHERE id = ${postId}`
  await sql`DELETE FROM products WHERE id IN (${productAId}, ${productBId})`
  await sql`DELETE FROM wa_groups WHERE jid = ${GROUP}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("a code reply, unquoted, resolves against the group's bound event", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-1", sender: HER, text: `${codeA} mau 1`, quoted: "",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "📝")
  const [row] = await sql`SELECT status, product_id, qty FROM catalogue_requests WHERE message_id = 'her-1'`
  assert.equal(row.status, "pending")
  assert.equal(row.product_id, productAId)
  assert.equal(row.qty, 1)
})

test("a code reply, quoted to the post, resolves the same way", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-2", sender: HER, text: `${codeB} mau 2`, quoted: "post-msg-1",
  })
  assert.equal(result.kind, "reacted")
  const [row] = await sql`SELECT product_id, qty FROM catalogue_requests WHERE message_id = 'her-2'`
  assert.equal(row.product_id, productBId)
  assert.equal(row.qty, 2)
})

test("an exact unique store-code token, with no minted code, is a direct claim", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-3", sender: HER, text: "fix 2099A1 kak, 1 aja", quoted: "",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "📝")
  const [row] = await sql`SELECT product_id, status FROM catalogue_requests WHERE message_id = 'her-3'`
  assert.equal(row.product_id, productAId)
  assert.equal(row.status, "pending")
})

test("an unrecognised code reacts sad and writes no row", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-4", sender: HER, text: "Z99 mau 1", quoted: "",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "😢")
  const [row] = await sql`SELECT 1 FROM catalogue_requests WHERE message_id = 'her-4'`
  assert.equal(row, undefined)
})

test("a message quoting a closed trip's send is refused", async () => {
  const closedEvent = `${EVENT}-closed`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${closedEvent}, id FROM warehouses ORDER BY id LIMIT 1`
  const closedSend = await createSend({ postId, event: closedEvent, title: "old trip" })
  await setSendMessageId(closedSend.id, "old-post-msg", GROUP)
  // The group is now bound to EVENT, not closedEvent — quoting the old post
  // resolves to closedEvent's send, which is not the group's live one.
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-5", sender: HER, text: "A21 mau 1", quoted: "old-post-msg",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "❌")
  const [row] = await sql`SELECT status FROM catalogue_requests WHERE message_id = 'her-5'`
  assert.equal(row.status, "rejected")
  await sql`DELETE FROM wa_sends WHERE id = ${closedSend.id}`
  await sql`DELETE FROM events WHERE name = ${closedEvent}`
})

test("no code and no candidate returns a disambiguation request with no candidates", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-6", sender: HER, text: "ini ready berapa hari lagi ya kak", quoted: "",
  })
  assert.equal(result.kind, "needsDisambiguation")
  if (result.kind === "needsDisambiguation") assert.deepEqual(result.candidates, [])
  // This function only decides there IS an ambiguity to ask about — it does
  // not write a row itself (Task 9's askDisambiguation does, after posting
  // the question), so no catalogue_requests row exists yet at this point.
  const [row] = await sql`SELECT 1 FROM catalogue_requests WHERE message_id = 'her-6'`
  assert.equal(row, undefined)
})

test("ordinary chat with no group bound to any send is not a product-post claim at all", async () => {
  const emptyGroup = `${process.hrtime.bigint()}-empty@g.us`
  const result = await resolveProductPostClaim({
    groupJid: emptyGroup, messageId: "her-7", sender: HER, text: "halo semua", quoted: "",
  })
  assert.equal(result.kind, "notApplicable")
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test worker/product-post.test.ts`
Expected: FAIL — `worker/product-post.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
import { parseCodes } from "@/lib/whatsapp/codes"
import { parseQuantity } from "@/lib/claims/quantity"
import { findCustomerByNumber } from "@/lib/whatsapp/identity"
import { normalizeNumber } from "@/lib/db/whatsapp-groups"
import {
  getOpenSendForGroup, getSendByMessage, getSendCodeByCode, listSendCodes, type WaSend, type WaSendCode,
} from "@/lib/db/wa-sends"
import { createDirectClaim, createRejectedClaim } from "@/lib/db/catalogue-requests"

export type ProductPostResolution =
  | { kind: "reacted"; emoji: string }
  | { kind: "needsDisambiguation"; send: WaSend; customerHandle: string; qty: number; note: string; candidates: WaSendCode[] }
  | { kind: "notApplicable" }

async function resolveSend(groupJid: string, quoted: string): Promise<WaSend | null> {
  if (quoted) return getSendByMessage(groupJid, quoted)
  return getOpenSendForGroup(groupJid)
}

async function resolveCustomerHandle(sender: string): Promise<string> {
  const number = normalizeNumber(sender)
  const handle = await findCustomerByNumber(number)
  return handle ?? number
}

/** Tokens in a product name at least 3 characters long — long enough that a
 *  match isn't noise, matching both the exact-token and fuzzy passes below. */
function nameTokens(productName: string): string[] {
  return productName.toLowerCase().split(/[\s-]+/).filter((t) => t.length >= 3)
}

/**
 * Resolve one incoming WhatsApp message against product-post sends.
 *
 * `"reacted"` means this function fully handled it — a direct claim (📝), an
 * unrecognised code (😢), or a closed trip (❌) — and already wrote whatever
 * row that implies. `"needsDisambiguation"` means the caller (Task 9's
 * askDisambiguation) must post the ❔ question before writing anything, since
 * this function has no live socket to post with. `"notApplicable"` means the
 * caller falls through to the existing shelf path.
 *
 * Text-driven only: unlike a shelf, a resent/unmarked photo of the post
 * creates nothing here.
 */
export async function resolveProductPostClaim(input: {
  groupJid: string; messageId: string; sender: string; text: string; quoted: string
}): Promise<ProductPostResolution> {
  const send = await resolveSend(input.groupJid, input.quoted)
  if (send === null) return { kind: "notApplicable" }

  const customerHandle = await resolveCustomerHandle(input.sender)
  const qty = parseQuantity(input.text)

  // Closed trip: the send resolved (by quote or by group binding) but its
  // event is not the group's currently-bound one.
  const openForGroup = await getOpenSendForGroup(input.groupJid)
  if (openForGroup === null || openForGroup.event !== send.event) {
    await createRejectedClaim({
      customerHandle, qty, note: input.text,
      sendId: send.id, sender: input.sender, messageId: input.messageId,
    })
    return { kind: "reacted", emoji: "❌" }
  }

  const codes = parseCodes(input.text)
  if (codes.length === 1) {
    const sendCode = await getSendCodeByCode(send.event, codes[0])
    if (sendCode === null) return { kind: "reacted", emoji: "😢" }
    await createDirectClaim({
      customerHandle, productId: sendCode.productId, qty, note: input.text,
      sendId: send.id, sendCodeId: sendCode.id, sender: input.sender, messageId: input.messageId,
    })
    return { kind: "reacted", emoji: "📝" }
  }

  const sendCodes = await listSendCodes(send.id)
  const lowerText = input.text.toLowerCase()

  // Exact, unique token match (e.g. a store code like "2099A1") — same
  // confidence as a typed code, so this is a direct claim, not a candidate.
  const exactMatches = sendCodes.filter((c) => nameTokens(c.productName).some((t) => lowerText.includes(t)))
  if (exactMatches.length === 1) {
    const match = exactMatches[0]
    await createDirectClaim({
      customerHandle, productId: match.productId, qty, note: input.text,
      sendId: send.id, sendCodeId: match.id, sender: input.sender, messageId: input.messageId,
    })
    return { kind: "reacted", emoji: "📝" }
  }
  if (exactMatches.length > 1) {
    return { kind: "needsDisambiguation", send, customerHandle, qty, note: input.text, candidates: exactMatches }
  }

  // No exact token either — a looser pass (partial word, e.g. a colour) for
  // the plausible-candidates ❔ case. Empty is a valid outcome: "kodenya
  // yang mana kak?" with nothing to offer.
  const fuzzyMatches = sendCodes.filter((c) =>
    nameTokens(c.productName).some((t) => lowerText.includes(t.slice(0, Math.max(3, t.length - 2)))),
  )
  return { kind: "needsDisambiguation", send, customerHandle, qty, note: input.text, candidates: fuzzyMatches }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsx --test worker/product-post.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add worker/product-post.ts worker/product-post.test.ts
git commit -m "feat(wa-sends): resolve an incoming message against product-post sends"
```

---

## Task 9: `worker/product-post-offer.ts` — asking the group and settling the answer

**Files:**
- Create: `worker/product-post-offer.ts`
- Test: `worker/product-post-offer.test.ts`

**Interfaces:**
- Consumes: `ProductPostResolution`'s `"needsDisambiguation"` case (Task 8);
  `createAskingRequest`, `resolveAskingCandidate`, `findRequestByBotMessage`
  (Task 6); `getSend`, `getSendCodeByCode` (Task 3). Writes its own short
  copy strings — not `renderCaption`, which is for the initial post only.
- Produces:
  ```ts
  export async function askDisambiguation(
    sock: WASocket,
    input: { groupJid: string; messageId: string; sender: string; text: string; quoted: string },
    resolution: Extract<ProductPostResolution, { kind: "needsDisambiguation" }>,
  ): Promise<string>
  // Always returns "❔" — kept as a return value (not hardcoded by the
  // caller) so the caller's code reads the same shape as every other
  // resolver in worker/index.ts.

  export async function trySendOfferAnswer(input: {
    groupJid: string; messageId: string; sender: string; text: string; quoted: string
  }): Promise<string | null>
  // A text reply naming one of the offered codes, settling a (usually
  // multi-candidate) open asking row. Returns "📝", or null if this message
  // is not an answer to anything open.

  export async function trySendOfferThumbsUp(groupJid: string, quotedMessageId: string): Promise<string | null>
  // A 👍 reaction landing on the bot's own single-candidate question.
  // Returns "✅", or null if it's not that (including: it lands on a
  // multi-candidate offer, which a bare 👍 can never settle).
  ```
  Task 10 wires all three into `worker/index.ts` — `trySendOfferAnswer` in
  the text-message dispatch, `trySendOfferThumbsUp` in the reaction handler.

- [ ] **Step 1: Write the failing tests**

```ts
import { test, before, after, mock } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { createSend, attachProductToSend, setSendMessageId } from "@/lib/db/wa-sends"
import { resolveProductPostClaim } from "./product-post"
import { askDisambiguation, trySendOfferAnswer, trySendOfferThumbsUp } from "./product-post-offer"

const EVENT = `TESTPPOFFER${process.hrtime.bigint()}`
const GROUP = `${process.hrtime.bigint()}@g.us`
const HER = "628111111111"
let postId: number
let productAId: number
let productBId: number
let sendId: number

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await sql`INSERT INTO wa_groups (jid, event, active) VALUES (${GROUP}, ${EVENT}, true) ON CONFLICT (jid) DO UPDATE SET event = EXCLUDED.event`
  const [post] = await sql`INSERT INTO catalogue_posts (media_url, media_type) VALUES ('https://example.com/t.jpg', 'photo') RETURNING id`
  postId = post.id as number
  const [a] = await sql`INSERT INTO products (name, store, price) VALUES ('Boston Bag 38L Greige', 'MUJI', 385000) RETURNING id`
  const [b] = await sql`INSERT INTO products (name, store, price) VALUES ('Boston Bag 38L Black', 'MUJI', 385000) RETURNING id`
  productAId = a.id as number
  productBId = b.id as number
  const send = await createSend({ postId, event: EVENT, title: "MUJI restock" })
  sendId = send.id
  await attachProductToSend(sendId, productAId)
  await attachProductToSend(sendId, productBId)
  await setSendMessageId(sendId, "post-msg-1", GROUP)
})

after(async () => {
  await sql`DELETE FROM catalogue_requests WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_send_codes WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_sends WHERE id = ${sendId}`
  await sql`DELETE FROM catalogue_post_products WHERE post_id = ${postId}`
  await sql`DELETE FROM catalogue_posts WHERE id = ${postId}`
  await sql`DELETE FROM products WHERE id IN (${productAId}, ${productBId})`
  await sql`DELETE FROM wa_groups WHERE jid = ${GROUP}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

function fakeSock(sentId: string) {
  return { sendMessage: mock.fn(async () => ({ key: { id: sentId } })) } as any
}

test("askDisambiguation with two candidates lists only the codes, never a bare number", async () => {
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-1", sender: HER, text: "bostonnya mau 1 dong", quoted: "",
  })
  assert.equal(resolution.kind, "needsDisambiguation")
  if (resolution.kind !== "needsDisambiguation") return

  const sock = fakeSock("bot-msg-1")
  const emoji = await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-1", sender: HER, text: "bostonnya mau 1 dong", quoted: "",
  }, resolution)
  assert.equal(emoji, "❔")

  const [sent] = sock.sendMessage.mock.calls
  const caption = sent.arguments[1].text as string
  assert.ok(!/balas\s+1\s+atau\s+2/i.test(caption), "must never offer numbered options")

  const [row] = await sql`SELECT status, bot_message_id, candidate_send_code_ids FROM catalogue_requests WHERE message_id = 'her-1'`
  assert.equal(row.status, "asking")
  assert.equal(row.bot_message_id, "bot-msg-1")
  assert.equal(row.candidate_send_code_ids.length, 2)
})

test("askDisambiguation with one candidate asks a yes/no confirmation", async () => {
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-2", sender: HER, text: "greige nya mau 1", quoted: "",
  })
  assert.equal(resolution.kind, "needsDisambiguation")
  if (resolution.kind !== "needsDisambiguation") return
  // This fixture's simple token matcher may or may not narrow to one
  // candidate for "greige" — assert on whatever it actually returned rather
  // than assuming; the shape under test is askDisambiguation, not the
  // resolver's fuzzy matching precision.

  const sock = fakeSock("bot-msg-2")
  await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-2", sender: HER, text: "greige nya mau 1", quoted: "",
  }, resolution)

  const [row] = await sql`SELECT candidate_send_code_ids FROM catalogue_requests WHERE message_id = 'her-2'`
  assert.equal(row.candidate_send_code_ids.length, resolution.candidates.length)
})

test("trySendOfferAnswer settles a code reply against the offered candidates only", async () => {
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-3", sender: HER, text: "bostonnya mau 1", quoted: "",
  })
  assert.equal(resolution.kind, "needsDisambiguation")
  if (resolution.kind !== "needsDisambiguation") return
  const sock = fakeSock("bot-msg-3")
  await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-3", sender: HER, text: "bostonnya mau 1", quoted: "",
  }, resolution)

  const offeredCode = (await sql`SELECT sc.code FROM catalogue_requests r JOIN wa_send_codes sc ON sc.id = r.candidate_send_code_ids[1] WHERE r.message_id = 'her-3'`)[0].code as string

  const emoji = await trySendOfferAnswer({
    groupJid: GROUP, messageId: "her-3-reply", sender: HER, text: `${offeredCode}`, quoted: "bot-msg-3",
  })
  assert.equal(emoji, "📝")

  const [row] = await sql`SELECT status, product_id FROM catalogue_requests WHERE message_id = 'her-3'`
  assert.equal(row.status, "pending")
})

test("a second answer to an already-resolved offer does nothing", async () => {
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-4", sender: HER, text: "bostonnya mau 1", quoted: "",
  })
  if (resolution.kind !== "needsDisambiguation") return
  const sock = fakeSock("bot-msg-4")
  await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-4", sender: HER, text: "bostonnya mau 1", quoted: "",
  }, resolution)
  const offeredCode = (await sql`SELECT sc.code FROM catalogue_requests r JOIN wa_send_codes sc ON sc.id = r.candidate_send_code_ids[1] WHERE r.message_id = 'her-4'`)[0].code as string

  await trySendOfferAnswer({ groupJid: GROUP, messageId: "her-4-a", sender: HER, text: offeredCode, quoted: "bot-msg-4" })
  const emoji = await trySendOfferAnswer({ groupJid: GROUP, messageId: "her-4-b", sender: HER, text: offeredCode, quoted: "bot-msg-4" })
  assert.equal(emoji, null, "the offer is already answered")
})

test("trySendOfferAnswer returns null for a reply quoting no open offer", async () => {
  const emoji = await trySendOfferAnswer({
    groupJid: GROUP, messageId: "her-5", sender: HER, text: "K01", quoted: "not-an-offer",
  })
  assert.equal(emoji, null)
})

test("trySendOfferThumbsUp settles a one-candidate offer", async () => {
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-6", sender: HER, text: "yang hitam mau 1", quoted: "",
  })
  if (resolution.kind !== "needsDisambiguation" || resolution.candidates.length !== 1) return
  const sock = fakeSock("bot-msg-6")
  await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-6", sender: HER, text: "yang hitam mau 1", quoted: "",
  }, resolution)

  const emoji = await trySendOfferThumbsUp(GROUP, "bot-msg-6")
  assert.equal(emoji, "✅")
  const [row] = await sql`SELECT status FROM catalogue_requests WHERE message_id = 'her-6'`
  assert.equal(row.status, "pending")
})

test("trySendOfferThumbsUp does nothing for a multi-candidate offer", async () => {
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-7", sender: HER, text: "bostonnya mau 1", quoted: "",
  })
  if (resolution.kind !== "needsDisambiguation") return
  const sock = fakeSock("bot-msg-7")
  await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-7", sender: HER, text: "bostonnya mau 1", quoted: "",
  }, resolution)
  const emoji = await trySendOfferThumbsUp(GROUP, "bot-msg-7")
  assert.equal(emoji, null)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test worker/product-post-offer.test.ts`
Expected: FAIL — `worker/product-post-offer.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
import type { WASocket } from "baileys"
import { getSend, getSendCodeByCode } from "@/lib/db/wa-sends"
import { parseCodes } from "@/lib/whatsapp/codes"
import { createAskingRequest, resolveAskingCandidate, findRequestByBotMessage } from "@/lib/db/catalogue-requests"
import type { ProductPostResolution } from "./product-post"

/**
 * Post the ❔ question and write the asking row, in that order — the row
 * needs the sent message's id (bot_message_id) to be answerable later, so
 * the send must happen first.
 */
export async function askDisambiguation(
  sock: WASocket,
  input: { groupJid: string; messageId: string; sender: string; text: string; quoted: string },
  resolution: Extract<ProductPostResolution, { kind: "needsDisambiguation" }>,
): Promise<string> {
  const question =
    resolution.candidates.length === 1
      ? `Maksudnya ${resolution.candidates[0].code} ${resolution.candidates[0].productName} — Rp ${resolution.candidates[0].price.toLocaleString("id-ID")} ya kak? 👍 kalau betul`
      : resolution.candidates.length > 1
        ? `Yang mana kak?\n${resolution.candidates.map((c) => `${c.code} ${c.productName}`).join(" · ")}\nBalas kodenya ya 🙏`
        : "Kodenya yang mana kak? 🙏"

  const sent = await sock.sendMessage(
    input.groupJid,
    { text: question },
    { quoted: { key: { remoteJid: input.groupJid, id: input.messageId, fromMe: false }, message: {} } },
  )
  const botMessageId = sent?.key?.id ?? ""

  await createAskingRequest({
    customerHandle: resolution.customerHandle,
    qty: resolution.qty,
    note: input.text,
    sendId: resolution.send.id,
    sender: input.sender,
    messageId: input.messageId,
    botMessageId,
    candidateSendCodeIds: resolution.candidates.map((c) => c.id),
  })

  return "❔"
}

/**
 * Settle an open asking row from the customer side — either a 👍 landing on
 * the bot's confirmation question (single candidate), or a text reply
 * naming one of the offered codes (multiple candidates). Checked before the
 * generic claim path in worker/index.ts, mirroring how trySizeOffer/
 * trySizeAnswer are checked ahead of the shelf claim path today.
 */
export async function trySendOfferAnswer(input: {
  groupJid: string; messageId: string; sender: string; text: string; quoted: string
}): Promise<string | null> {
  if (!input.quoted) return null
  const request = await findRequestByBotMessage(input.quoted)
  if (request === null) return null

  const codes = parseCodes(input.text)
  if (codes.length !== 1) return null

  const candidateIds = request.candidateSendCodeIds ?? []
  if (candidateIds.length === 0) return null

  // Resolve the typed code to a wa_send_codes row via the request's own
  // send (for its event), then confirm it is one of the codes actually
  // offered — a code she types that wasn't among the options must not
  // silently resolve here.
  const send = await getSend(request.sendId!)
  if (send === null) return null
  const sendCode = await getSendCodeByCode(send.event, codes[0])
  if (sendCode === null || !candidateIds.includes(sendCode.id)) return null

  await resolveAskingCandidate(request.id, sendCode.id, "customer")
  return "📝"
}

/** A 👍 landing on the bot's own single-candidate question. */
export async function trySendOfferThumbsUp(groupJid: string, quotedMessageId: string): Promise<string | null> {
  const request = await findRequestByBotMessage(quotedMessageId)
  if (request === null) return null
  const candidateIds = request.candidateSendCodeIds ?? []
  if (candidateIds.length !== 1) return null // multi-candidate offers are never settled by a bare 👍

  await resolveAskingCandidate(request.id, candidateIds[0], "customer")
  return "✅"
}
```

If `CatalogueRequest`'s type (Task 6's `toCatalogueRequest` mapper) does not
expose `candidateSendCodeIds`/`sendId` under exactly those camelCase names,
use whatever names Task 6 actually shipped — reconcile in favor of the real
mapper, not this plan's text, and note the discrepancy in your report.

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsx --test worker/product-post-offer.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add worker/product-post-offer.ts worker/product-post-offer.test.ts
git commit -m "feat(wa-sends): ask and settle the disambiguation offer"
```

---

## Task 10: Wire it all into `worker/index.ts`

**Files:**
- Modify: `worker/index.ts`

**Interfaces:**
- Consumes: `resolveProductPostClaim` (Task 8), `askDisambiguation`,
  `trySendOfferAnswer`, `trySendOfferThumbsUp` (Task 9).
- Produces: nothing new — this task only adds dispatch branches to the
  existing `onMessage` and `messages.reaction` handlers.

- [ ] **Step 1: Read `worker/index.ts`'s `onMessage` and the `messages.reaction`
  handler in full** (do not skim — this task inserts into an existing
  dispatch chain and must not reorder the checks already there).

- [ ] **Step 2: Add the imports**

```ts
import { resolveProductPostClaim } from "./product-post"
import { askDisambiguation, trySendOfferAnswer, trySendOfferThumbsUp } from "./product-post-offer"
```

- [ ] **Step 3: Add the text-message branch inside `onMessage`**

Insert this **before** step 7 (`postForReply`) in the existing dispatch
order from the research (after `trySizeOffer`, since that also quotes a
message and must keep priority — a product-post claim and a size-offer
answer are never the same message, but checking order matters if the
matching logic is ever loosened later):

```ts
const offerEmoji = await trySendOfferAnswer({
  groupJid, messageId, sender, text, quoted,
})
if (offerEmoji !== null) {
  reactions?.push({ jid: groupJid, key: message.key, emoji: offerEmoji })
  return
}

const resolution = await resolveProductPostClaim({ groupJid, messageId, sender, text, quoted })
if (resolution.kind === "reacted") {
  reactions?.push({ jid: groupJid, key: message.key, emoji: resolution.emoji })
  return
}
if (resolution.kind === "needsDisambiguation") {
  const emoji = await askDisambiguation(sock, { groupJid, messageId, sender, text, quoted }, resolution)
  reactions?.push({ jid: groupJid, key: message.key, emoji })
  return
}
// resolution.kind === "notApplicable" — fall through to the existing shelf/claim path below.
```

Use whatever local variable names `onMessage` already has in scope for
`groupJid`/`messageId`/`sender`/`text`/`quoted` — match the existing
function's variable names exactly rather than introducing new ones with
the same meaning.

- [ ] **Step 4: Add the reaction branch inside the `messages.reaction` handler**

Insert **before** the existing `trySizeAnswer` check (a 👍 could in
principle land on either kind of offer; product-post offers are new and
should not silently lose to a size-offer check that returns `null` for
them anyway — but check first regardless, to keep the ordering obvious
rather than relying on both returning `null` correctly):

```ts
const sendAnswerEmoji = await trySendOfferThumbsUp(groupJid, quotedMessageId)
if (sendAnswerEmoji !== null) {
  reactions?.push({ jid: groupJid, key: message.key, emoji: sendAnswerEmoji })
  continue // or whatever the existing loop's per-reaction control flow uses — match it exactly
}
```

Match the existing handler's exact variable names for `groupJid` and the
quoted/target message id (the research did not capture this handler's
body — read it in Step 1 and use its real names, not the placeholders
above).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: every test passes, including all pre-existing `worker/*.test.ts`
files — this task only adds branches, and must not change behavior for a
message that isn't a product-post claim or offer answer.

- [ ] **Step 7: Commit**

```bash
git add worker/index.ts
git commit -m "feat(wa-sends): wire product-post resolution into the worker's message dispatch"
```

---

## Final check

- [ ] Run `npm test` once more from a clean state and confirm the count
  grew by 55 tests (11 + 7 + 8 + 4 + 8 + 3 + 7 + 7 across Tasks 2–9) over
  the 214 present before this plan started.
- [ ] Run `npx tsc --noEmit` once more.
- [ ] Confirm `git log --oneline` shows one commit per task, ten total.
