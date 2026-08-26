# Overpayments To Check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the overpayment detector creating refunds by itself, and put what it used to write into a reviewable "To check" tab where a person decides.

**Architecture:** One tested arithmetic function (`uncovered`) becomes the single definition of "money owed that no refund covers". Three places consume it — the detector's reconcile pass, the To-check list, and the Dashboard count — so they can never disagree. `materializeOverpaymentRefunds` loses its INSERT; its reconcile and cancel passes stay for rows that already exist.

**Tech Stack:** Next.js 16 (App Router), TypeScript, postgres.js against Supabase Postgres, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-08-26-refunds-from-marks-design.md`

## Global Constraints

- Read `node_modules/next/dist/docs/` before writing Next-specific code. This is Next 16; APIs differ from training data (see `AGENTS.md`).
- Money is integer rupiah throughout. Never floats.
- All refund amounts and comparisons use `status <> 'cancelled'` to mean "live".
- Never modify a refund that has a linked payment: `NOT EXISTS (SELECT 1 FROM payments p WHERE p.refund_id = r.id)`. Once money has moved, the row belongs to a person.
- Tests run with `npm test`, which globs `lib/*.test.ts` and `lib/db/*.test.ts`. A test outside those paths does not run.
- Every `/api/sheets/*` route calls `requireSession()` then a role check. `/dashboard/refunds` is in `ADMIN_ROUTES`, so the route uses `requireRole`, not `requireOwner`.
- Small-amount threshold is `SMALL_OVERPAYMENT_IDR = 10_000`, a module constant. Not configurable.

---

## File Structure

| file | responsibility |
|---|---|
| `lib/db/refund-residual.ts` *(new)* | `uncovered()` and `residualExcluding()` — pure integer arithmetic, no database |
| `lib/db/refund-residual.test.ts` *(new)* | its tests |
| `lib/db/overpayments.ts` *(new)* | `listOverpaymentsToCheck()`, `createRefundFromOverpayment()` |
| `lib/db/overpayments.test.ts` *(new)* | its tests, against the local database |
| `lib/db/finance.ts` *(modify)* | drop the INSERT; reconcile from the residual excluding itself |
| `lib/db/dashboard.ts` *(modify)* | count what is uncovered |
| `app/api/sheets/overpayments/route.ts` *(new)* | GET the list, POST to create a refund from a row |
| `app/dashboard/refunds/RefundsClient.tsx` *(modify)* | the To check tab |
| `app/dashboard/DashboardClient.tsx` *(modify)* | tile label and link |

---

### Task 1: The arithmetic, alone

**Files:**
- Create: `lib/db/refund-residual.ts`
- Test: `lib/db/refund-residual.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `uncovered(totalPaid: number, invoiceTotal: number, liveRefundAmounts: number[]): number`
  - `residualExcluding(totalPaid: number, invoiceTotal: number, liveRefunds: { id: number; amount: number }[], excludeId: number): number`
  - `SMALL_OVERPAYMENT_IDR: number` (10_000)

- [ ] **Step 1: Write the failing test**

Create `lib/db/refund-residual.test.ts`:

```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { uncovered, residualExcluding, SMALL_OVERPAYMENT_IDR } from "./refund-residual"

test("nothing is uncovered when the invoice was paid exactly", () => {
  assert.equal(uncovered(500_000, 500_000, []), 0)
})

test("an overpayment with no refunds is uncovered in full", () => {
  assert.equal(uncovered(550_000, 500_000, []), 50_000)
})

test("a refund covering the whole overpayment leaves nothing", () => {
  // A mark refunded the sold-out item; the invoice fell by the same amount.
  assert.equal(uncovered(550_000, 300_000, [250_000]), 0)
})

test("a refund covering part of it leaves exactly the remainder", () => {
  // Sold-out item worth 200_000 refunded; she had also overpaid by 50_000.
  assert.equal(uncovered(550_000, 300_000, [200_000]), 50_000)
})

test("refunds beyond the overpayment never make it negative", () => {
  assert.equal(uncovered(550_000, 500_000, [80_000]), 0)
})

test("underpayment is not a refund", () => {
  assert.equal(uncovered(400_000, 500_000, []), 0)
})

test("a row reconciles to the residual that excludes itself", () => {
  // 250_000 over. A mark's row holds 200_000; the overpayment row should hold 50_000.
  const refunds = [{ id: 1, amount: 200_000 }, { id: 2, amount: 999 }]
  assert.equal(residualExcluding(550_000, 300_000, refunds, 2), 50_000)
})

test("excluding a row that is not there changes nothing", () => {
  const refunds = [{ id: 1, amount: 200_000 }]
  assert.equal(residualExcluding(550_000, 300_000, refunds, 99), 50_000)
})

test("the small-amount threshold is ten thousand rupiah", () => {
  assert.equal(SMALL_OVERPAYMENT_IDR, 10_000)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test lib/db/refund-residual.test.ts`
Expected: FAIL — `Cannot find module './refund-residual'`

- [ ] **Step 3: Write the implementation**

Create `lib/db/refund-residual.ts`:

```ts
/**
 * How much of what a customer is owed no refund covers yet.
 *
 * Three places need this figure — the detector's reconcile pass, the To-check
 * list, and the Dashboard count — and they must never disagree about it, so it
 * is computed once here rather than written three times in SQL.
 *
 * Integer rupiah throughout. Never floats: money that rounds is money that
 * argues.
 */

/** Below this, an overpayment is collapsed in the To-check list rather than listed. */
export const SMALL_OVERPAYMENT_IDR = 10_000

/**
 * What is owed and unrefunded.
 *
 * Underpayment is not a negative refund, and refunds exceeding the overpayment
 * do not owe money back the other way — both floor at zero.
 */
export function uncovered(
  totalPaid: number,
  invoiceTotal: number,
  liveRefundAmounts: number[],
): number {
  const over = totalPaid - invoiceTotal
  if (over <= 0) return 0
  const covered = liveRefundAmounts.reduce((sum, n) => sum + n, 0)
  return Math.max(0, over - covered)
}

/**
 * What one refund row should hold, given the others.
 *
 * Reconciling a row to the WHOLE overpayment would have it claim money a mark's
 * refund already claims, so the row being reconciled is left out of the sum.
 */
export function residualExcluding(
  totalPaid: number,
  invoiceTotal: number,
  liveRefunds: { id: number; amount: number }[],
  excludeId: number,
): number {
  return uncovered(
    totalPaid,
    invoiceTotal,
    liveRefunds.filter((r) => r.id !== excludeId).map((r) => r.amount),
  )
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test lib/db/refund-residual.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add lib/db/refund-residual.ts lib/db/refund-residual.test.ts
git commit -m "feat: one definition of how much a customer is still owed

Three places need the figure — the detector, the To-check list and the
Dashboard tile — and a disagreement between them is money either paid twice or
not at all. Computed once, in integers, with the two cases that look like
refunds and are not: an underpayment, and refunds already exceeding what was
overpaid. Both floor at zero."
```

---

### Task 2: The detector stops creating

**Files:**
- Modify: `lib/db/finance.ts` — `materializeOverpaymentRefunds`, around lines 818–920
- Test: `lib/db/overpayments.test.ts` (created here, extended in Task 3)

**Interfaces:**
- Consumes: `residualExcluding` from Task 1.
- Produces: `materializeOverpaymentRefunds()` keeps its signature `(): Promise<RefundRow[]>` and now always returns `[]` — nothing is inserted. Callers need no change.

- [ ] **Step 1: Write the failing test**

Create `lib/db/overpayments.test.ts`:

```ts
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { materializeOverpaymentRefunds, getRefunds } from "./finance"

const TAG = `optest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const HANDLE = `${TAG}_cust`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${HANDLE})`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  // Ordered 500_000, paid 550_000 — overpaid by 50_000, nothing marked.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EVENT}, ${HANDLE}, ${productId}, 500000, 1)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${HANDLE}, 550000, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM refunds WHERE event = ${EVENT}`
  await sql`DELETE FROM payments WHERE event = ${EVENT}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${HANDLE}`
  await sql.end()
})

test("an overpayment no longer creates a refund by itself", async () => {
  // The whole point: nothing appears in Pending that nobody asked for.
  await materializeOverpaymentRefunds()
  const rows = await getRefunds({ event: EVENT })
  assert.equal(rows.length, 0, "the detector must not insert")
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/overpayments.test.ts`
Expected: FAIL — one refund was created, so `rows.length` is 1.

- [ ] **Step 3: Remove the INSERT**

In `lib/db/finance.ts`, `materializeOverpaymentRefunds`: delete the final `INSERT INTO refunds … RETURNING *` statement (the CTE body beginning `-- Brand-new overpayments`). The `WITH` chain must still end in a statement, so end it with a `SELECT` that returns no rows and keeps the data-modifying CTEs running:

```sql
    SELECT * FROM refunds WHERE false
```

Replace the function's doc comment first line with:

```ts
/**
 * Keep existing overpayment refunds honest. Creates nothing.
 *
 * It used to insert, and wrote 224 of 232 live refunds — rows that were right
 * about the money and silent about the cause, and that nobody had asked for.
 * What it used to write is now the To-check list, where a person decides.
 * Reconcile and cancel stay: rows already exist and must not drift.
 */
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/overpayments.test.ts`
Expected: PASS

- [ ] **Step 5: Reconcile must exclude the row it is reconciling**

Add to `lib/db/overpayments.test.ts`:

```ts
test("a reconciled row holds only what other refunds do not", async () => {
  // A mark refunded 200_000 of the 250_000 she is owed; an older auto-created
  // overpayment row must settle at 50_000, not 250_000, or the two together
  // claim 450_000 against a 250_000 debt.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EVENT}, ${HANDLE}, ${productId}, -200000, 1)`   // the mark's reduction
  const [mark] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EVENT}, ${HANDLE}, 'unavailable', 200000, 'pending') RETURNING id`
  const [auto] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EVENT}, ${HANDLE}, 'overpayment', 250000, 'pending') RETURNING id`

  await materializeOverpaymentRefunds()

  const [row] = await sql<{ refund_amount: number }[]>`
    SELECT refund_amount FROM refunds WHERE id = ${auto.id}`
  assert.equal(row.refund_amount, 50000)

  const [other] = await sql<{ refund_amount: number }[]>`
    SELECT refund_amount FROM refunds WHERE id = ${mark.id}`
  assert.equal(other.refund_amount, 200000, "a mark's row is never rewritten")
})
```

Run it: expect FAIL — the row reconciles to 250000.

- [ ] **Step 6: Make reconcile subtract the other live refunds**

In the `reconciled` CTE, replace `(l.total_paid - l.invoice_total)` in both the `SET` and the two `WHERE` comparisons with the residual excluding the row itself:

```sql
    reconciled AS (
      UPDATE refunds r
      SET refund_amount = GREATEST(0, (l.total_paid - l.invoice_total) - COALESCE((
            SELECT SUM(o.refund_amount) FROM refunds o
             WHERE o.event = r.event AND o.customer = r.customer
               AND o.status <> 'cancelled' AND o.id <> r.id
          ), 0)),
          note = 'Auto-detected: paid Rp ' || l.total_paid || ' of Rp ' || l.invoice_total,
          updated_at = NOW()
      FROM live l
      WHERE r.event = l.event AND r.customer = l.customer
        AND r.reason = 'overpayment'
        AND r.status IN ('pending', 'awaiting_bank_info', 'ready_to_refund')
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.refund_id = r.id)
        AND (l.total_paid - l.invoice_total) > 0
        AND GREATEST(0, (l.total_paid - l.invoice_total) - COALESCE((
              SELECT SUM(o.refund_amount) FROM refunds o
               WHERE o.event = r.event AND o.customer = r.customer
                 AND o.status <> 'cancelled' AND o.id <> r.id
            ), 0)) <> r.refund_amount
      RETURNING r.id
    ),
```

- [ ] **Step 7: Run both tests**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/overpayments.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 8: Full suite, then commit**

```bash
npm test
git add lib/db/finance.ts lib/db/overpayments.test.ts
git commit -m "feat: the overpayment detector stops writing refunds

It wrote 224 of 232 live refunds — right about the money, silent about the
cause, and asked for by nobody. What it used to insert becomes a list to
review; this removes the insert.

Reconcile stays, and now settles a row to what the OTHER live refunds leave
uncovered. Set to the whole overpayment, an auto-created row and a mark's
refund would each claim the same money."
```

---

### Task 3: The To-check list

**Files:**
- Create: `lib/db/overpayments.ts`
- Modify: `lib/db/overpayments.test.ts`

**Interfaces:**
- Consumes: `uncovered`, `SMALL_OVERPAYMENT_IDR` from Task 1; `getPaymentStatus(event?: string): Promise<PaymentStatusRow[]>` from `./finance`, where `PaymentStatusRow` is `{ event, customer, invoiceTotal, totalPaid, outstanding, totalItems, status }`.
- Produces:
  - `type OverpaymentToCheck = { event: string; customer: string; totalPaid: number; invoiceTotal: number; uncovered: number; refundedSoFar: number }`
  - `listOverpaymentsToCheck(): Promise<OverpaymentToCheck[]>` — sorted by `uncovered` descending
  - `createRefundFromOverpayment(event: string, customer: string, actor?: string | null): Promise<{ id: number; amount: number }>`

- [ ] **Step 1: Write the failing tests**

Append to `lib/db/overpayments.test.ts`:

```ts
import { listOverpaymentsToCheck, createRefundFromOverpayment } from "./overpayments"

test("an uncovered overpayment appears in the list", async () => {
  await sql`DELETE FROM refunds WHERE event = ${EVENT}`
  const rows = await listOverpaymentsToCheck()
  const mine = rows.find((r) => r.event === EVENT && r.customer === HANDLE)
  assert.ok(mine, "the pair must be listed")
  assert.equal(mine.uncovered, 50000)
  assert.equal(mine.totalPaid, 550000)
})

test("a refund covering it removes it from the list", async () => {
  await sql`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EVENT}, ${HANDLE}, 'overpayment', 50000, 'pending')`
  const rows = await listOverpaymentsToCheck()
  assert.equal(rows.find((r) => r.event === EVENT && r.customer === HANDLE), undefined)
  await sql`DELETE FROM refunds WHERE event = ${EVENT}`
})

test("creating a refund from a row clears it and lands in Pending", async () => {
  const made = await createRefundFromOverpayment(EVENT, HANDLE, "tester")
  assert.equal(made.amount, 50000)

  const [row] = await sql<{ reason: string; status: string; refund_amount: number }[]>`
    SELECT reason, status, refund_amount FROM refunds WHERE id = ${made.id}`
  assert.equal(row.reason, "overpayment")
  assert.equal(row.status, "pending")
  assert.equal(row.refund_amount, 50000)

  const rows = await listOverpaymentsToCheck()
  assert.equal(rows.find((r) => r.event === EVENT && r.customer === HANDLE), undefined)
  await sql`DELETE FROM refunds WHERE event = ${EVENT}`
})

test("creating a refund when nothing is uncovered is refused", async () => {
  await sql`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EVENT}, ${HANDLE}, 'overpayment', 50000, 'pending')`
  await assert.rejects(() => createRefundFromOverpayment(EVENT, HANDLE, "tester"))
  await sql`DELETE FROM refunds WHERE event = ${EVENT}`
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/overpayments.test.ts`
Expected: FAIL — `Cannot find module './overpayments'`

- [ ] **Step 3: Write the implementation**

Create `lib/db/overpayments.ts`:

```ts
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { getPaymentStatus } from "./finance"
import { uncovered } from "./refund-residual"

/**
 * Money a customer is owed that no refund covers yet.
 *
 * Not refunds. A row here is an observation — the arithmetic noticing a gap —
 * and becomes a refund only when somebody decides it is worth sending. That
 * separation is the point: Pending is a to-do list, and a Rp 2.000 shipping
 * rounding is not a task.
 */
export type OverpaymentToCheck = {
  event: string
  customer: string
  totalPaid: number
  invoiceTotal: number
  /** What live refunds already claim for this pair. */
  refundedSoFar: number
  uncovered: number
}

/** Live refund totals per (event, customer). */
async function refundedByPair(db: DBExecutor): Promise<Map<string, number>> {
  const rows = await db<{ event: string; customer: string; total: string }[]>`
    SELECT event, customer, SUM(refund_amount) AS total
      FROM refunds
     WHERE status <> 'cancelled'
     GROUP BY event, customer
  `
  const m = new Map<string, number>()
  for (const r of rows) m.set(`${r.event}|${r.customer}`, Number(r.total))
  return m
}

export async function listOverpaymentsToCheck(
  db: DBExecutor = sql,
): Promise<OverpaymentToCheck[]> {
  const [statuses, refunded] = await Promise.all([getPaymentStatus(), refundedByPair(db)])

  const out: OverpaymentToCheck[] = []
  for (const s of statuses) {
    const refundedSoFar = refunded.get(`${s.event}|${s.customer}`) ?? 0
    const gap = uncovered(s.totalPaid, s.invoiceTotal, [refundedSoFar])
    if (gap <= 0) continue
    out.push({
      event: s.event,
      customer: s.customer,
      totalPaid: s.totalPaid,
      invoiceTotal: s.invoiceTotal,
      refundedSoFar,
      uncovered: gap,
    })
  }
  // Largest first: that is the order they get worked.
  return out.sort((a, b) => b.uncovered - a.uncovered)
}

/**
 * Promote one row to a refund.
 *
 * Recomputes the figure rather than trusting one sent from a browser — the
 * list may be minutes old, and the amount is money.
 */
export async function createRefundFromOverpayment(
  event: string,
  customer: string,
  actor?: string | null,
): Promise<{ id: number; amount: number }> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`

    const rows = await listOverpaymentsToCheck(tx)
    const row = rows.find((r) => r.event === event && r.customer === customer)
    if (!row) throw new Error("Nothing is uncovered for this customer on this trip")

    const [made] = await tx<{ id: number }[]>`
      INSERT INTO refunds (event, customer, reason, refund_amount, note)
      VALUES (${event}, ${customer}, 'overpayment', ${row.uncovered},
              ${`Paid Rp ${row.totalPaid} of Rp ${row.invoiceTotal}`})
      RETURNING id
    `
    return { id: made.id, amount: row.uncovered }
  })
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/overpayments.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Export from the db barrel**

In `lib/db.ts`, re-export:

```ts
export { listOverpaymentsToCheck, createRefundFromOverpayment, type OverpaymentToCheck } from "./db/overpayments"
```

- [ ] **Step 6: Full suite, then commit**

```bash
npm test
git add lib/db/overpayments.ts lib/db/overpayments.test.ts lib/db.ts
git commit -m "feat: overpayments a person has not decided about yet

The list the detector used to write straight into Pending. A row here is an
observation, not a debt the system has committed to, and it carries what she
paid and what she was invoiced so a small gap can be recognised as rounding
without opening the invoice.

Creating a refund from a row recomputes the amount rather than trusting one
sent from a browser. The list may be minutes old and the figure is money."
```

---

### Task 4: The API route

**Files:**
- Create: `app/api/sheets/overpayments/route.ts`

**Interfaces:**
- Consumes: `listOverpaymentsToCheck`, `createRefundFromOverpayment` from Task 3; `requireSession`, `requireRole` from `@/lib/api`; `withActor` from `@/lib/db`.
- Produces: `GET /api/sheets/overpayments` → `{ rows: OverpaymentToCheck[] }`; `POST` with `{ event, customer }` → `{ id, amount }`.

- [ ] **Step 1: Write the route**

There is no route-test harness in this project — every existing route is covered by its db-layer tests plus `tsc`. Follow that. Create `app/api/sheets/overpayments/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { listOverpaymentsToCheck, createRefundFromOverpayment } from "@/lib/db"

// Money a customer is owed that no refund covers. Read by the Refunds page's
// "To check" tab and counted on the Dashboard, which must agree with it.
export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    return NextResponse.json({ rows: await listOverpaymentsToCheck() },
      { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to list overpayments to check:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  let body: { event?: unknown; customer?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const event = typeof body.event === "string" ? body.event.trim() : ""
  const customer = typeof body.customer === "string" ? body.customer.trim() : ""
  if (!event || !customer) {
    return NextResponse.json({ error: "event and customer are required" }, { status: 400 })
  }

  try {
    // Not wrapped in withActor: it opens a transaction, and
    // createRefundFromOverpayment opens its own. Nesting them deadlocks on the
    // same connection — the same trap issueInvite documents. It takes the actor
    // directly and sets app.actor inside its own transaction.
    const made = await createRefundFromOverpayment(event, customer, session.user.email)
    return NextResponse.json(made)
  } catch (err) {
    // "Nothing is uncovered" is the caller acting on a stale list, not a fault.
    const message = err instanceof Error ? err.message : "Failed to create refund"
    console.error("Failed to create a refund from an overpayment:", err)
    return NextResponse.json({ error: message }, { status: 409 })
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add app/api/sheets/overpayments/route.ts
git commit -m "feat: an endpoint for overpayments to check

GET lists what is owed and unrefunded; POST promotes one row to a refund.
Owner and admin both reach the Refunds page, so this checks a role rather than
ownership. A stale list answers 409 rather than 500 — acting on a row that has
since been covered is the caller being out of date, not a fault."
```

---

### Task 5: The Dashboard counts the same thing

**Files:**
- Modify: `lib/db/dashboard.ts` around lines 108–118
- Modify: `app/dashboard/DashboardClient.tsx:60`

**Interfaces:**
- Consumes: nothing new.
- Produces: `overpaymentCandidates` keeps its name and type; its meaning becomes "pairs with money uncovered".

- [ ] **Step 1: Change the count**

In `lib/db/dashboard.ts`, in the `overpayment_candidates` subquery, replace the `NOT EXISTS (...)` clause with a comparison against what live refunds already cover:

```sql
          AND (
            COALESCE(pa.total_paid, 0) - (
              oa.subtotal
              + COALESCE(cwo.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
              + COALESCE(adj.total_adj, 0)
            )
          ) > COALESCE((
            SELECT SUM(r.refund_amount) FROM refunds r
             WHERE r.event = oa.event AND r.customer = oa.customer
               AND r.status <> 'cancelled'
          ), 0)
```

Read the surrounding subquery first and reuse its own aliases for paid and invoiced rather than the names above — they must match what is in scope there.

Add above it:

```sql
        -- Counts what the To-check list shows, so the tile and the tab can
        -- never disagree. Asking "is there an overpayment row" instead would
        -- count every customer a mark had already refunded, for ever: a refund
        -- does not move the invoice.
```

- [ ] **Step 2: Change the tile's words**

In `app/dashboard/DashboardClient.tsx:60`:

```diff
-    { count: summary.actionQueue.overpaymentCandidates, label: "overpayments to refund", href: "/dashboard/refunds", tone: "yellow" },
+    { count: summary.actionQueue.overpaymentCandidates, label: "overpayments to check", href: "/dashboard/refunds?tab=to_check", tone: "yellow" },
```

- [ ] **Step 3: Verify the count matches the list**

Run this against the local database and confirm both numbers are equal:

```bash
cat > /tmp/agree.ts <<'EOF'
import sql from "@/lib/db-pool"
import { getDashboardSummary } from "@/lib/db/dashboard"
import { listOverpaymentsToCheck } from "@/lib/db/overpayments"
const [s, rows] = [await getDashboardSummary(), await listOverpaymentsToCheck()]
console.log("tile:", s.actionQueue.overpaymentCandidates, "list:", rows.length)
await sql.end()
EOF
npx tsx --env-file-if-exists=.env.development.local /tmp/agree.ts && rm /tmp/agree.ts
```

Expected: the two numbers are equal. If they are not, the SQL and `uncovered()` disagree — fix the SQL, not the function.

- [ ] **Step 4: Full suite and typecheck, then commit**

```bash
npx tsc --noEmit && npm test
git add lib/db/dashboard.ts app/dashboard/DashboardClient.tsx
git commit -m "fix: the dashboard counts what is uncovered, not what has no row

It asked whether an overpayment refund existed. Once a mark refunds a
sold-out item that question answers no for ever, because a refund does not
move the invoice — so the tile would have counted every refunded customer
until somebody paid them.

It now counts what the To-check list shows, and says 'to check' because that
is what it links to: things to look at, not money already committed."
```

---

### Task 6: The To check tab

**Files:**
- Modify: `app/dashboard/refunds/RefundsClient.tsx` — `ACTIVE_TABS` at line 52, tab state at 97, filtering at 122–128, rendering from 265

**Interfaces:**
- Consumes: `GET/POST /api/sheets/overpayments` from Task 4; `SMALL_OVERPAYMENT_IDR` from Task 1.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Read the file's existing patterns first**

Run: `sed -n '40,140p' app/dashboard/refunds/RefundsClient.tsx`

Note how `tab` is held, how `ACTIVE_TABS` renders, and how counts are shown beside labels. Follow those exactly — this task adds a tab, it does not restyle the page.

- [ ] **Step 2: Add the tab and its data**

- Add `{ key: "to_check", label: "To check" }` to `ACTIVE_TABS` **after** `pending`.
- Widen the tab state type to `RefundStatus | "to_check"`.
- Fetch `/api/sheets/overpayments` when the tab is first shown, into `const [toCheck, setToCheck] = useState<OverpaymentToCheck[] | null>(null)`.
- When `tab === "to_check"`, render the list instead of the refund table.

Rows, largest first, each showing customer · trip, paid, invoiced, uncovered, and a **Create refund** button that POSTs `{ event, customer }` then removes the row and refreshes the refund list.

Rows with `uncovered < SMALL_OVERPAYMENT_IDR` collapse into one `<details>` whose summary reads `N under Rp 10.000 · Rp X in total`. They are inside the element, one click away — never dropped.

- [ ] **Step 3: Guard the empty and error states**

Empty list: `No overpayments to check.` Failure: show the server's message. Use `await res.json().catch(() => ({}))` — a route that dies returns no body, and parsing it reports a JSON error instead of the failure.

- [ ] **Step 4: Typecheck and run**

```bash
npx tsc --noEmit && npm test
```

- [ ] **Step 5: Check it by hand**

Start the dev server (`npm run dev`, port 3001), open `/dashboard/refunds`, and confirm: the tab appears after Pending; its count matches the Dashboard tile; small amounts are collapsed with a correct total; Create refund moves a row into Pending and removes it from To check.

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/refunds/RefundsClient.tsx
git commit -m "feat: a To check tab, so Pending stays a to-do list

Every row in Pending is money you have decided to send, which is what makes it
worth reading carefully. A Rp 2.000 shipping rounding is not a task, and
putting it there teaches you to skim the one list that must not be skimmed.

To check holds what the arithmetic noticed and nobody has decided about.
Largest first, because that is the order they get worked; paid and invoiced
beside the gap so rounding is recognisable without opening the invoice; and
everything under Rp 10.000 folded into one line so twenty-three of them cannot
bury the three that matter."
```

---

## Self-Review

**Spec coverage.** Detector stops inserting — Task 2. Reconcile excludes itself — Task 2. To-check list, ordering, threshold, paid/invoiced columns — Tasks 3 and 6. Create refund from a row — Tasks 3, 4, 6. Dashboard counts the uncovered and relabels — Task 5. Residual computed once — Task 1, consumed by 2, 3 and 5.

**Not covered here, by design:** marks creating refunds, the `wrong_item` reason, notice templates, and the outstanding-elsewhere prompt. Those are Plans 2 and 3. Plan 2 must not start before this plan ships, or every mark produces a double.

**Types.** `uncovered(totalPaid, invoiceTotal, liveRefundAmounts)` and `residualExcluding(...)` are used with those exact names in Tasks 2, 3 and 5. `OverpaymentToCheck` has the same six fields in Tasks 3, 4 and 6. `listOverpaymentsToCheck` takes an optional `DBExecutor` so `createRefundFromOverpayment` can call it inside its own transaction.

**Known soft spot, flagged rather than hidden.** Task 5 Step 1 says to read the surrounding subquery before writing, because the Dashboard's aliases for paid and invoiced are in scope there and are not reproduced here; guessing them would be wrong.

`withActor` was checked while writing this: it is `withActor(actor, fn(tx))` and opens its own transaction, so Task 4 calls `createRefundFromOverpayment` directly. Nesting the two would deadlock on one connection, which `issueInvite` already documents.
