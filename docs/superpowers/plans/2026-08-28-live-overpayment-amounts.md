# Live Overpayment Amounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An overpayment refund that is still being decided shows what she is actually owed right now, instead of a number stored when it was created.

**Architecture:** A `live_balances` database view gives invoice/paid/balance per (event, customer). `getRefunds` left-joins it and substitutes the live figure for refunds that are still open and are overpayments; everything else keeps its stored amount. `executeRefund` re-reads the live figure at the moment of transfer and writes it to the row as it freezes. The "Needs review" badge is deleted, because nothing can drift any more.

**Tech Stack:** Next.js 16 App Router, TypeScript, postgres.js, Supabase Postgres, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-08-28-live-overpayment-amounts-design.md`

## Global Constraints

- **Migration number is 118.** 117 is taken (`117_operational_expense_currency.sql`, committed 28 Aug).
- **Migrations are applied by hand** in the Supabase SQL editor as `postgres`. The app role cannot run DDL. Apply to dev with a throwaway tsx script; production is the owner's step.
- **Handles normalize as `lower(replace(x, '@', ''))`.** Never join on the raw column.
- **Only `reason = 'overpayment'` is ever live.** An unknown or free-text reason (production has one literally called `"Out of stock"`) is stored, never live.
- **Live statuses are exactly** `pending`, `awaiting_bank_info`, `ready_to_refund`. `applied_to_next_order` is a deposit and stays stored.
- **Money code, so: never guess.** Where a figure could be either stored or live, the test asserts which.
- **Run `npm test` before every commit.** 625 tests pass as of `8f2090a`.

---

### Task 1: The rule, on its own

A pure predicate, no database. Everything downstream asks it, so it is worth having one answer in one place.

**Files:**
- Create: `lib/db/live-refund.ts`
- Test: `lib/db/live-refund.test.ts`

**Interfaces:**
- Produces: `export type LiveRefundFields = { reason: string; status: string }` and `export function isLiveAmount(row: LiveRefundFields): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// lib/db/live-refund.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { isLiveAmount } from "./live-refund"

test("an overpayment still being decided is live", () => {
  for (const status of ["pending", "awaiting_bank_info", "ready_to_refund"]) {
    assert.equal(isLiveAmount({ reason: "overpayment", status }), true, status)
  }
})

test("a settled overpayment is frozen at what was settled", () => {
  for (const status of ["refunded", "cancelled"]) {
    assert.equal(isLiveAmount({ reason: "overpayment", status }), false, status)
  }
})

test("a deposit is a fixed sum on her account, not a claim on a balance", () => {
  // She chose to keep it. Where it came from stops mattering, and nothing
  // about it should move afterwards.
  assert.equal(isLiveAmount({ reason: "overpayment", status: "applied_to_next_order" }), false)
})

test("a goods refund is the price of a thing, so it never moves", () => {
  // The Bucket Hat is Rp 160.000 whether or not she orders ten more items.
  for (const reason of ["unavailable", "damaged", "quality", "shipping_loss", "wrong_item"]) {
    assert.equal(isLiveAmount({ reason, status: "pending" }), false, reason)
  }
})

test("an unrecognised reason is stored, never live", () => {
  // Production holds one whose reason is the literal string "Out of stock".
  // Guessing that it means `unavailable` would put a balance on a price.
  assert.equal(isLiveAmount({ reason: "Out of stock", status: "pending" }), false)
  assert.equal(isLiveAmount({ reason: "", status: "pending" }), false)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test lib/db/live-refund.test.ts`
Expected: FAIL — `Cannot find module './live-refund'`

- [ ] **Step 3: Write the module**

```ts
// lib/db/live-refund.ts

/**
 * Whether a refund's amount is read from her ledger or from the row.
 *
 * An overpayment describes a balance, and balances move: cindyalyssa_'s
 * Rp 482.000 became Rp 2.000 four days later because she ordered socks on the
 * same trip. While the refund is still being decided, the honest figure is
 * whatever she is overpaid by right now.
 *
 * Everything else is a price, or a decision already made:
 *   - a goods refund is what the item cost, and does not care about her balance
 *   - a deposit is a fixed sum she chose to keep
 *   - a paid or cancelled refund is history
 */
export type LiveRefundFields = { reason: string; status: string }

const LIVE_STATUSES = new Set(["pending", "awaiting_bank_info", "ready_to_refund"])

export function isLiveAmount(row: LiveRefundFields): boolean {
  return row.reason === "overpayment" && LIVE_STATUSES.has(row.status)
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test lib/db/live-refund.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add lib/db/live-refund.ts lib/db/live-refund.test.ts
git commit -m "feat: one rule for whether a refund's amount is live"
```

---

### Task 2: The view

**Files:**
- Create: `supabase/migrations/118_live_balances_view.sql`
- Test: `lib/db/live-balances.test.ts`

**Interfaces:**
- Produces: view `live_balances(event text, customer text, invoice_total int, total_paid int, balance int)`, where `customer` is the **normalized** handle and `balance` is `total_paid - invoice_total` (positive = she has overpaid).

- [ ] **Step 1: Write the failing test**

```ts
// lib/db/live-balances.test.ts
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"

const TAG = `livebal${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const WHO = `@${TAG}_Mixed`          // typed with an @ and capitals, on purpose
const KEY = `${TAG.toLowerCase()}_mixed`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, gram, price) VALUES (${`${TAG} thing`}, 0, 100000) RETURNING id`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EV}, ${WHO}, ${productId}, 100000, 3)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${WHO}, 500000, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`%${TAG}%`}`
  await sql.end()
})

test("the view keys on the normalized handle, not the typed one", async () => {
  // "@Fandrianr" and "fandrianr" are one person. An exact join matches neither
  // reliably, and the failure is silent: every balance looks like zero.
  const [row] = await sql<{ customer: string; invoice_total: number; total_paid: number; balance: number }[]>`
    SELECT customer, invoice_total, total_paid, balance
      FROM live_balances WHERE event = ${EV}`
  assert.equal(row.customer, KEY)
  assert.equal(row.invoice_total, 300000, "3 × 100.000, no ongkir on a zero-gram product")
  assert.equal(row.total_paid, 500000)
  assert.equal(row.balance, 200000, "positive means she has overpaid")
})

test("the balance follows the orders", async () => {
  await sql`UPDATE orders SET unit = 5 WHERE event = ${EV}`
  const [row] = await sql<{ balance: number }[]>`
    SELECT balance FROM live_balances WHERE event = ${EV}`
  assert.equal(row.balance, 0, "500.000 paid against 500.000 ordered")
})

test("unchecked payments do not count", async () => {
  // Same rule as getPaymentStatus: money is money when somebody has confirmed it.
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${WHO}, 900000, false, 'deposit')`
  const [row] = await sql<{ balance: number }[]>`
    SELECT balance FROM live_balances WHERE event = ${EV}`
  assert.equal(row.balance, 0)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/live-balances.test.ts`
Expected: FAIL — `relation "live_balances" does not exist`

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/118_live_balances_view.sql
--
-- What each customer owes and has paid on each trip, as it stands right now.
--
-- Same arithmetic as getPaymentStatus, in one place the refunds query can join
-- against: subtotal + ongkir per rounded kilo + adjustments, against checked
-- payments. An overpayment refund that is still being decided reads its amount
-- from here rather than storing one, because a stored balance goes stale the
-- moment anything on the trip changes.
--
-- Every join is on the normalized handle. The 12 July draft of this view joined
-- customers.instagram_id to orders.customer exactly; handles are stored however
-- they were typed, so "@Fandrianr" and "fandrianr" would each match nothing and
-- every balance would quietly read zero.
CREATE OR REPLACE VIEW live_balances AS
WITH order_aggregates AS (
  SELECT o.event AS event,
         lower(replace(o.customer, '@', '')) AS cust_key,
         SUM(o.unit_price * o.unit) AS subtotal,
         SUM(COALESCE(p.gram, 0) * o.unit) AS total_gram
    FROM orders o
    JOIN products p ON p.id = o.product_id
   GROUP BY 1, 2
),
payment_aggregates AS (
  SELECT event, lower(replace(customer, '@', '')) AS cust_key, SUM(amount) AS total_paid
    FROM payments
   WHERE is_checked = true
   GROUP BY 1, 2
),
adjustment_aggregates AS (
  SELECT event, lower(replace(customer, '@', '')) AS cust_key, SUM(amount) AS total_adj
    FROM adjustments
   GROUP BY 1, 2
),
customer_ongkir AS (
  SELECT ev.name AS event,
         lower(replace(c.instagram_id, '@', '')) AS cust_key,
         COALESCE(cwo.ongkos_kirim, 0) AS ongkos_kirim
    FROM events ev
    JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
    JOIN customers c ON c.id = cwo.customer_id
)
SELECT oa.event,
       oa.cust_key AS customer,
       (oa.subtotal
         + COALESCE(co.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
         + COALESCE(adj.total_adj, 0))::int AS invoice_total,
       COALESCE(pa.total_paid, 0)::int AS total_paid,
       (COALESCE(pa.total_paid, 0)
         - (oa.subtotal
            + COALESCE(co.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
            + COALESCE(adj.total_adj, 0)))::int AS balance
  FROM order_aggregates oa
  LEFT JOIN payment_aggregates pa ON pa.event = oa.event AND pa.cust_key = oa.cust_key
  LEFT JOIN adjustment_aggregates adj ON adj.event = oa.event AND adj.cust_key = oa.cust_key
  LEFT JOIN customer_ongkir co ON co.event = oa.event AND co.cust_key = oa.cust_key;

COMMENT ON VIEW live_balances IS
  'Per (event, customer) invoice/paid/balance on normalized handles. Read by open overpayment refunds.';
```

- [ ] **Step 4: Apply it to dev**

```bash
cat > ./_m.mts <<'EOF'
import postgres from "postgres"
import fs from "node:fs"
const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
await sql.unsafe(fs.readFileSync("supabase/migrations/118_live_balances_view.sql", "utf8"))
console.log("applied")
await sql.end()
EOF
npx tsx --env-file-if-exists=.env.development.local ./_m.mts && rm -f ./_m.mts
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/live-balances.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/118_live_balances_view.sql lib/db/live-balances.test.ts
git commit -m "feat: a view of what each customer owes right now"
```

---

### Task 3: The refunds list reads it

**Files:**
- Modify: `lib/db/finance.ts` (the `getRefunds` query at ~line 574, and `mapRefundRow` at ~line 500)
- Test: `lib/db/live-refund-amounts.test.ts`

**Interfaces:**
- Consumes: `isLiveAmount` from Task 1; view `live_balances` from Task 2.
- Produces: `getRefunds` returns `refundAmount` = the live balance for a live refund (floored at 0), the stored column otherwise.

- [ ] **Step 1: Write the failing test**

```ts
// lib/db/live-refund-amounts.test.ts
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getRefunds } from "./finance"

const TAG = `liveamt${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const WHO = `${TAG}_c`
let productId = 0

const amountOf = async (id: number) =>
  (await getRefunds({ event: EV })).find((r) => r.rowNumber === id)?.refundAmount

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, gram, price) VALUES (${`${TAG} thing`}, 0, 100000) RETURNING id`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EV}, ${WHO}, ${productId}, 100000, 3)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${WHO}, 500000, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("an open overpayment shows what she is owed now, not when it was written", async () => {
  // She has paid 500.000 against 300.000 of orders: 200.000 overpaid.
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 200000, 'pending') RETURNING id`
  assert.equal(await amountOf(r.id), 200000)

  // She orders two more. Nothing touches the refund row.
  await sql`UPDATE orders SET unit = 5 WHERE event = ${EV}`
  assert.equal(await amountOf(r.id), 0, "the overpayment is gone, and so is the refund's amount")

  // And back again when the order shrinks.
  await sql`UPDATE orders SET unit = 4 WHERE event = ${EV}`
  assert.equal(await amountOf(r.id), 100000)
  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
  await sql`DELETE FROM refunds WHERE id = ${r.id}`
})

test("she can never be owed a negative amount", async () => {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 200000, 'pending') RETURNING id`
  await sql`UPDATE orders SET unit = 9 WHERE event = ${EV}`   // she now owes 400.000
  assert.equal(await amountOf(r.id), 0, "owing money is not a negative refund")
  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
  await sql`DELETE FROM refunds WHERE id = ${r.id}`
})

test("a goods refund keeps its stored price", async () => {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'unavailable', 160000, 'pending') RETURNING id`
  await sql`UPDATE orders SET unit = 5 WHERE event = ${EV}`
  assert.equal(await amountOf(r.id), 160000, "the item cost what it cost")
  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
  await sql`DELETE FROM refunds WHERE id = ${r.id}`
})

test("a deposit keeps its stored figure", async () => {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 200000, 'applied_to_next_order') RETURNING id`
  await sql`UPDATE orders SET unit = 5 WHERE event = ${EV}`
  assert.equal(await amountOf(r.id), 200000, "she chose to keep this; it is hers")
  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
  await sql`DELETE FROM refunds WHERE id = ${r.id}`
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/live-refund-amounts.test.ts`
Expected: FAIL on the second assertion of the first test — it returns the stored 200000.

- [ ] **Step 3: Join the view in `getRefunds`**

In `lib/db/finance.ts`, add the import at the top:

```ts
import { isLiveAmount } from "./live-refund"
```

Replace the `sql.unsafe` query inside `getRefunds` (currently `SELECT r.*, EXISTS(...) AS has_applied_credit, (SELECT ...) AS applied_credit_amount FROM refunds r ${where} ORDER BY r.created_at DESC`) with:

```ts
  const rows = await sql.unsafe(
    `SELECT r.*,
            EXISTS (SELECT 1 FROM payments p WHERE p.refund_id = r.id AND p.kind = 'credit') AS has_applied_credit,
            (SELECT COALESCE(SUM(p.amount), 0)::int FROM payments p
             WHERE p.refund_id = r.id AND p.kind = 'credit' AND p.amount > 0) AS applied_credit_amount,
            lb.balance AS live_balance
     FROM refunds r
     LEFT JOIN live_balances lb
            ON lb.event = r.event
           AND lb.customer = lower(replace(r.customer, '@', ''))
     ${where} ORDER BY r.created_at DESC`,
    params,
  )
  return rows.map(mapRefundRow)
```

Note the `attachStaleReview(...)` wrapper is gone; Task 6 deletes the function itself.

Then in `mapRefundRow`, replace the `refundAmount` line:

```ts
    refundAmount: liveAmount(r),
```

and add this helper immediately above `mapRefundRow`:

```ts
/**
 * What the row is worth right now.
 *
 * A refund still being decided reads her balance: the stored number was true
 * when it was written and stops being true the moment anything on the trip
 * moves. Floored at zero — a customer who now owes money is not owed a
 * negative refund, she is owed nothing.
 *
 * Everything else keeps what is stored. See lib/db/live-refund.ts for which is
 * which, and why.
 */
function liveAmount(r: Record<string, unknown>): number {
  const stored = (r.refund_amount as number) ?? 0
  if (!isLiveAmount({ reason: r.reason as string, status: r.status as string })) return stored
  const balance = r.live_balance as number | null | undefined
  return balance == null ? stored : Math.max(0, balance)
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/live-refund-amounts.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: the refunds tests that assert stored amounts on open overpayments will now fail. Read each one: if it is asserting the old stored behaviour on an open overpayment, update it to assert the live figure, with a comment saying why. Do **not** weaken an assertion about a goods refund or a deposit — those must not have changed.

- [ ] **Step 6: Commit**

```bash
git add lib/db/finance.ts lib/db/live-refund-amounts.test.ts
git commit -m "feat: an open overpayment refund reads her balance"
```

---

### Task 4: Paying it out freezes the live figure

**Files:**
- Modify: `lib/db/finance.ts` — `executeRefund` at ~line 645
- Test: `lib/db/live-refund-execute.test.ts`

**Interfaces:**
- Consumes: `isLiveAmount`, `live_balances`.
- Produces: `executeRefund` writes a payment for the live figure and sets `refunds.refund_amount` to it.

- [ ] **Step 1: Write the failing test**

```ts
// lib/db/live-refund-execute.test.ts
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { executeRefund } from "./finance"

const TAG = `liveexec${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const WHO = `${TAG}_c`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, gram, price) VALUES (${`${TAG} thing`}, 0, 100000) RETURNING id`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EV}, ${WHO}, ${productId}, 100000, 3)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${WHO}, 500000, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("the transfer is for what she is owed at that moment, and freezes there", async () => {
  // Written when she was owed 200.000; by the time it is paid she has ordered
  // more and is owed 100.000. The transfer must be the smaller figure.
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 200000, 'ready_to_refund') RETURNING id`
  await sql`UPDATE orders SET unit = 4 WHERE event = ${EV}`

  await executeRefund(r.id, `${TAG}-ref`, "BCA", "tester")

  const [row] = await sql<{ refund_amount: number; status: string }[]>`
    SELECT refund_amount::int AS refund_amount, status FROM refunds WHERE id = ${r.id}`
  assert.equal(row.refund_amount, 100000, "frozen at what was actually paid")
  assert.equal(row.status, "refunded")

  const [pay] = await sql<{ amount: number }[]>`
    SELECT amount::int AS amount FROM payments WHERE refund_id = ${r.id} AND kind = 'refund'`
  assert.equal(pay.amount, -100000, "money out, at the same figure")
})

test("a goods refund pays exactly what it says", async () => {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'unavailable', 160000, 'ready_to_refund') RETURNING id`
  await executeRefund(r.id, `${TAG}-ref2`, "BCA", "tester")
  const [pay] = await sql<{ amount: number }[]>`
    SELECT amount::int AS amount FROM payments WHERE refund_id = ${r.id} AND kind = 'refund'`
  assert.equal(pay.amount, -160000)
})

test("nothing owed cannot be paid out", async () => {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 200000, 'ready_to_refund') RETURNING id`
  await sql`UPDATE orders SET unit = 9 WHERE event = ${EV}`   // she owes money now
  await assert.rejects(() => executeRefund(r.id, `${TAG}-ref3`, "BCA", "tester"), /nothing/i)
  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/live-refund-execute.test.ts`
Expected: FAIL — the first test pays 200000.

- [ ] **Step 3: Read the live figure inside the transaction**

In `executeRefund`, after the existing `if (refund.status === "refunded") throw ...` guard and before `sql.begin`, nothing changes. Inside the transaction, immediately after the `set_config` line, insert:

```ts
    // Re-read at the moment of transfer, not when the screen was opened. This
    // is the last point at which the figure can still be right, so it is the
    // one that decides what leaves the bank -- and what the row freezes at.
    let amount = refund.refund_amount as number
    if (isLiveAmount({ reason: refund.reason as string, status: refund.status as string })) {
      const [live] = await tx<{ balance: number }[]>`
        SELECT balance FROM live_balances
         WHERE event = ${refund.event as string}
           AND customer = lower(replace(${refund.customer as string}, '@', ''))`
      amount = Math.max(0, live?.balance ?? 0)
    }
    if (!(amount > 0)) {
      throw new Error("There is nothing owed on this refund any more")
    }
```

Then change the payment insert's amount from `${-(refund.refund_amount as number)}` to `${-amount}`, and add `refund_amount = ${amount},` to the `UPDATE refunds SET ...` that sets `status = 'refunded'`.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/live-refund-execute.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
npm test
git add lib/db/finance.ts lib/db/live-refund-execute.test.ts
git commit -m "feat: pay what she is owed at the moment of transfer"
```

---

### Task 5: Applying credit caps against the live figure

**Files:**
- Modify: `lib/db/finance.ts` — `applyRefundAsCredit` at ~line 706
- Test: `lib/db/live-refund-credit.test.ts`

**Interfaces:**
- Consumes: `isLiveAmount`, `live_balances`.
- Produces: `applyRefundAsCredit` validates `amount` against the live figure for a live refund, and freezes the row at the live figure when it becomes a deposit.

- [ ] **Step 1: Write the failing test**

```ts
// lib/db/live-refund-credit.test.ts
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { applyRefundAsCredit } from "./finance"

const TAG = `livecred${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const NEXT = `${TAG}_NEXT`
const WHO = `${TAG}_c`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, gram, price) VALUES (${`${TAG} thing`}, 0, 100000) RETURNING id`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  for (const e of [EV, NEXT]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${e}, ${WHO}, ${productId}, 100000, 3)`
  }
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${WHO}, 500000, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("you cannot move more credit than she is actually owed", async () => {
  // The row says 200.000; she has since ordered more and is owed 100.000.
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 200000, 'pending') RETURNING id`
  await sql`UPDATE orders SET unit = 4 WHERE event = ${EV}`

  await assert.rejects(
    () => applyRefundAsCredit(r.id, NEXT, 200000, "tester"),
    /exceeds/i,
    "the stored figure is not a licence to move money that is not there",
  )

  await applyRefundAsCredit(r.id, NEXT, 100000, "tester")
  const [row] = await sql<{ refund_amount: number; status: string }[]>`
    SELECT refund_amount::int AS refund_amount, status FROM refunds WHERE id = ${r.id}`
  assert.equal(row.refund_amount, 0)
  assert.equal(row.status, "applied_to_next_order")
  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/live-refund-credit.test.ts`
Expected: FAIL — the 200000 application succeeds.

- [ ] **Step 3: Read the live figure before validating**

In `applyRefundAsCredit`, replace:

```ts
    const remaining = refund.refund_amount as number
    if (!(remaining > 0)) throw new Error("Nothing left to apply")
```

with:

```ts
    // What she is owed now, not what the row was written with. Moving a stale
    // figure onto another trip spends money that is no longer there, and the
    // credit payment makes it look deliberate afterwards.
    let remaining = refund.refund_amount as number
    if (isLiveAmount({ reason: refund.reason as string, status: refund.status as string })) {
      const [live] = await tx<{ balance: number }[]>`
        SELECT balance FROM live_balances
         WHERE event = ${refund.event as string}
           AND customer = lower(replace(${refund.customer as string}, '@', ''))`
      remaining = Math.max(0, live?.balance ?? 0)
    }
    if (!(remaining > 0)) throw new Error("Nothing left to apply")
```

The existing `if (amount > remaining) throw new Error(...)` line below it now compares against the live figure and needs no change.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/live-refund-credit.test.ts`
Expected: PASS, 1 test

- [ ] **Step 5: Commit**

```bash
npm test
git add lib/db/finance.ts lib/db/live-refund-credit.test.ts
git commit -m "feat: credit is capped by what she is owed, not by the row"
```

---

### Task 6: Delete the review badge

Nothing can drift now, so the machinery that warned about drift is dead weight — and worse, it would show a warning comparing a live figure with itself.

**Files:**
- Modify: `lib/db/finance.ts` — delete `attachStaleReview` (~lines 526–554) and `ACTIVE_REFUND_STATUSES`
- Modify: `lib/db/types.ts` — delete `liveOverpayment` from `RefundRow`
- Modify: `app/dashboard/refunds/RefundsClient.tsx` — delete `reviewMessage` (~line 268) and its four call sites (~414, ~495, ~1484)

**Interfaces:**
- Consumes: nothing.
- Produces: `RefundRow` no longer has `liveOverpayment`.

- [ ] **Step 1: Find every use**

```bash
grep -rn "liveOverpayment\|attachStaleReview\|reviewMessage\|ACTIVE_REFUND_STATUSES" app lib --include="*.ts" --include="*.tsx"
```

Expected: `lib/db/finance.ts`, `lib/db/types.ts`, `app/dashboard/refunds/RefundsClient.tsx`.

- [ ] **Step 2: Delete them**

Remove `attachStaleReview` and `ACTIVE_REFUND_STATUSES` from `finance.ts`; the call site was already removed in Task 3. Remove `liveOverpayment: null,` from `mapRefundRow` and the field from `RefundRow` in `types.ts`. In `RefundsClient.tsx`, delete `reviewMessage` and every block that renders its result — each call site is `const msg = reviewMessage(r)` followed by a conditional amber block; delete both.

- [ ] **Step 3: Check it compiles and builds**

```bash
npx tsc --noEmit && npm run build
```
Expected: clean. Any error naming `liveOverpayment` is a call site missed in Step 2.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS. A test asserting the badge appears should be deleted with the feature — say so in its commit rather than weakening it.

- [ ] **Step 5: Commit**

```bash
git add lib/db/finance.ts lib/db/types.ts app/dashboard/refunds/RefundsClient.tsx
git commit -m "refactor: drop the drift warning, now that nothing can drift"
```

---

### Task 7: The To-check list stops trusting stored amounts

`listOverpaymentsToCheck` sums `refunds.refund_amount` to know what is already covered. For a live refund that stored figure is now decorative, so an overpayment could look uncovered and be offered twice.

**Files:**
- Modify: `lib/db/overpayments.ts` — `refundedByPair` (~line 33) and `listOverpaymentsToCheck` (~line 47)
- Test: `lib/db/overpayments.test.ts` (existing file — add to it)

**Interfaces:**
- Consumes: `isLiveAmount`.
- Produces: an open overpayment refund covers the whole overpayment on its trip, whatever its stored figure says.

- [ ] **Step 1: Write the failing test**

Append to `lib/db/overpayments.test.ts` (reuse that file's existing fixtures and TAG):

```ts
test("an open overpayment refund covers the trip, whatever its stored figure says", async () => {
  // Its amount is live now, so the stored column is decorative. Summing it
  // would make a covered overpayment look uncovered and offer it a second time.
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 1, 'pending') RETURNING id`
  const rows = await listOverpaymentsToCheck()
  assert.equal(
    rows.some((o) => o.event === EV && o.customer === WHO.toLowerCase()), false,
    "already has a refund open — not something to check again",
  )
  await sql`DELETE FROM refunds WHERE id = ${r.id}`
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/overpayments.test.ts`
Expected: FAIL — the row is listed, because Rp 1 does not cover the overpayment.

- [ ] **Step 3: Treat a live refund as full cover**

In `lib/db/overpayments.ts`, add the import:

```ts
import { isLiveAmount } from "./live-refund"
```

Change `refundedByPair` to return both the covered total and whether an open overpayment refund exists:

```ts
async function refundedByPair(db: DBExecutor): Promise<Map<string, { total: number; hasLive: boolean }>> {
  const rows = await db<{ event: string; cust_key: string; total: string; reason: string; status: string }[]>`
    SELECT event,
           lower(replace(customer, '@', '')) AS cust_key,
           refund_amount AS total,
           reason,
           status
      FROM refunds
     WHERE status <> 'cancelled'
  `
  const m = new Map<string, { total: number; hasLive: boolean }>()
  for (const r of rows) {
    const key = `${r.event}|${r.cust_key}`
    const cur = m.get(key) ?? { total: 0, hasLive: false }
    // A live refund's stored figure means nothing — its presence is the cover.
    if (isLiveAmount({ reason: r.reason, status: r.status })) cur.hasLive = true
    else cur.total += Number(r.total)
    m.set(key, cur)
  }
  return m
}
```

Then in `listOverpaymentsToCheck`, where the covered amount is read, skip the pair entirely when `hasLive` is true. Read the existing arithmetic and keep its shape; the only change is an early `continue` (or filter) for `hasLive`.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/overpayments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npm test
git add lib/db/overpayments.ts lib/db/overpayments.test.ts
git commit -m "fix: an open overpayment refund is cover, not an amount to sum"
```

---

### Task 8: Check it against production's real rows

Not a code change — a read, before any of this reaches production.

**Files:** none.

- [ ] **Step 1: Compare stored against live for every open overpayment refund**

```bash
cat > ./_q.mts <<'EOF'
import postgres from "postgres"
const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
const rows = await sql`
  SELECT r.id, r.event, r.customer, r.refund_amount::int AS stored,
         GREATEST(0, COALESCE(lb.balance, 0))::int AS live, r.status
    FROM refunds r
    LEFT JOIN live_balances lb
           ON lb.event = r.event
          AND lb.customer = lower(replace(r.customer, '@', ''))
   WHERE r.reason = 'overpayment'
     AND r.status IN ('pending','awaiting_bank_info','ready_to_refund')
   ORDER BY ABS(r.refund_amount - GREATEST(0, COALESCE(lb.balance, 0))) DESC`
rows.forEach((r: any) => console.log(
  `#${r.id} ${r.event} ${r.customer} stored ${r.stored} live ${r.live} ${r.stored === r.live ? "" : "<-- CHANGES"}`))
await sql.end()
EOF
npx tsx --env-file-if-exists=.env.local ./_q.mts; rm -f ./_q.mts
```

- [ ] **Step 2: Read the output with the owner**

Every row marked `CHANGES` is one whose displayed amount will move the day this deploys. `cindyalyssa_` · LSCN202606 is the known one: stored 482.000, live 2.000. Anything unexpected is a question to answer **before** deploying, not after.

- [ ] **Step 3: Hand the migration to the owner**

`118_live_balances_view.sql` must run on production **before** the code deploys — `getRefunds` joins the view on every load of the Refunds page, and a missing view fails that page entirely. Migrations are applied by hand in the Supabase SQL editor.

---

## Self-Review

**Spec coverage:**

| spec requirement | task |
|---|---|
| `live_balances` view, normalized handles | 2 |
| open overpayment reads the balance | 3 |
| deposits and goods refunds stay stored | 1 (rule), 3 (asserted) |
| execute pays live and freezes | 4 |
| credit capped by live | 5 |
| review badge deleted | 6 |
| To-check stops summing live rows | 7 |
| unknown reasons are stored | 1 |
| migration is 118 | 2 |

**Placeholders:** none — every step has its code or its command.

**Type consistency:** `isLiveAmount({ reason, status })` is used identically in Tasks 3, 4, 5 and 7. The view's column is `balance` throughout; `customer` is the normalized handle in the view and normalized at every join site.

**One gap worth naming:** Task 3's Step 5 says to update existing tests that assert stored amounts on open overpayments, but cannot list them — they depend on the suite's state at execution time. That is deliberate: the instruction is to read each failure and decide, not to blanket-update.
