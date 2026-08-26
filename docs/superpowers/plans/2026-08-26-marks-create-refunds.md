# Marks Create Refunds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an item is marked sold out, missing, broken or wrong, create the refund with that reason and tell the customer — in one transaction, and only for customers who actually paid for the units removed.

**Architecture:** One tested arithmetic function (`owed`) decides each affected customer's amount. Both marks then call the existing `sendInvoiceNotice`, which already writes the refund and the inbox notice together. The notice wording already exists in `REFUND_CAUSES`; only `wrong_item` is new.

**Tech Stack:** Next.js 16 (App Router), TypeScript, postgres.js against Supabase Postgres, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-08-26-refunds-from-marks-design.md`

**Depends on:** `docs/superpowers/plans/2026-08-26-overpayments-to-check.md`, which must already be merged. While the detector still inserts, every mark produces a double.

## Global Constraints

- Read `node_modules/next/dist/docs/` before writing Next-specific code. This is Next 16 (see `AGENTS.md`).
- Money is integer rupiah. Never floats.
- Customer handles are compared normalized — `lower(replace(customer, '@', ''))`. The raw column carries whatever spelling was stored, and comparing it directly silently matches nothing. This has already caused one bug in this feature.
- `sendInvoiceNotice` refuses any `{token}` it does not know, so title and body must be fully resolved with `fillNotice` before the call.
- Tests run with `npm test`, globbing `lib/*.test.ts` and `lib/db/*.test.ts`.
- **A reduction only owes a refund if the customer already paid for those units.** Reducing an unpaid order lowers what they owe; refunding there invents a debt.

## Out of scope, and why

- **Undoing a mark.** Neither `markProductOutOfStock` nor `recordNotReceived` has an undo path — the spec's "undoing a mark cancels its refund" describes a flow that does not exist. Nothing to build.
- **`cancelled` mode.** A customer cancellation creates no refund here (spec, and confirmed).
- Marks writing adjustments to move the invoice.

---

## File Structure

| file | responsibility |
|---|---|
| `lib/db/refund-owed.ts` *(new)* | `owed()` — what one customer is owed for units removed |
| `lib/db/refund-owed.test.ts` *(new)* | its tests |
| `lib/db/types.ts` *(modify)* | `wrong_item` in `REFUND_REASONS` |
| `lib/notice-templates.ts` *(modify)* | a `wrong_item` cause and its sentence |
| `lib/db/mark-refunds.ts` *(new)* | the shared "reduce → owe → refund + notify" step both marks call |
| `lib/db/mark-refunds.test.ts` *(new)* | its tests, against the local database |
| `lib/db/shopping-list.ts` *(modify)* | `markProductOutOfStock` calls it |
| `lib/db/fulfillment.ts` *(modify)* | `recordNotReceived` calls it for missing/broken/wrong |

---

### Task 1: What one customer is owed

**Files:**
- Create: `lib/db/refund-owed.ts`
- Test: `lib/db/refund-owed.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `owed(unitsRemoved: number, unitPrice: number, totalPaid: number, invoiceTotalAfter: number): number`

- [ ] **Step 1: Write the failing test**

Create `lib/db/refund-owed.test.ts`:

```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { owed } from "./refund-owed"

test("a customer who paid nothing is owed nothing", () => {
  // Their order shrank, so they owe less. Nothing comes back.
  assert.equal(owed(2, 100_000, 0, 300_000), 0)
})

test("a fully paid customer is owed what was removed", () => {
  // Paid 500_000 for five units; two removed, invoice now 300_000.
  assert.equal(owed(2, 100_000, 500_000, 300_000), 200_000)
})

test("a part-paid customer is owed only what they overpaid", () => {
  // Paid 350_000 against a 500_000 order. Two units removed leaves the invoice
  // at 300_000, so only 50_000 of their money is now surplus.
  assert.equal(owed(2, 100_000, 350_000, 300_000), 50_000)
})

test("a customer still short after the reduction is owed nothing", () => {
  assert.equal(owed(2, 100_000, 250_000, 300_000), 0)
})

test("removing nothing owes nothing", () => {
  assert.equal(owed(0, 100_000, 500_000, 500_000), 0)
})

test("a free item owes nothing however much was paid", () => {
  assert.equal(owed(3, 0, 500_000, 500_000), 0)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test lib/db/refund-owed.test.ts`
Expected: FAIL — `Cannot find module './refund-owed'`

- [ ] **Step 3: Write the implementation**

Create `lib/db/refund-owed.ts`:

```ts
/**
 * What one customer is owed for units taken off their order.
 *
 * Not simply the value of what was removed. Reducing an UNPAID order lowers
 * what that customer owes — nothing comes back to them, and refunding there
 * would invent a debt. So the value of the removed units is capped by how much
 * of their money is actually surplus once the invoice has fallen.
 *
 * Integer rupiah. Never floats.
 */
export function owed(
  unitsRemoved: number,
  unitPrice: number,
  totalPaid: number,
  invoiceTotalAfter: number,
): number {
  const value = Math.max(0, unitsRemoved) * Math.max(0, unitPrice)
  if (value <= 0) return 0
  const surplus = totalPaid - invoiceTotalAfter
  if (surplus <= 0) return 0
  return Math.min(value, surplus)
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test lib/db/refund-owed.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add lib/db/refund-owed.ts lib/db/refund-owed.test.ts
git commit -m "feat: what a customer is owed when their order shrinks

Not the value of what was removed. Reducing an unpaid order lowers what they
owe and returns nothing, so the removed units' value is capped by how much of
their money is surplus once the invoice has fallen. Refunding the value
outright would invent a debt to somebody who never paid."
```

---

### Task 2: A reason and a sentence for a wrong delivery

**Files:**
- Modify: `lib/db/types.ts:260` — `REFUND_REASONS`
- Modify: `lib/notice-templates.ts` — `REFUND_CAUSES`

**Interfaces:**
- Consumes: nothing.
- Produces: the string `"wrong_item"` is a valid `refunds.reason` and has a customer-facing sentence.

- [ ] **Step 1: Add the reason**

In `lib/db/types.ts`, extend the list — keep `other` last, it is the catch-all:

```ts
export const REFUND_REASONS: RefundReason[] = ["overpayment", "unavailable", "shipping_loss", "damaged", "wrong_item", "goodwill", "other"]
```

- [ ] **Step 2: Add the sentence**

In `lib/notice-templates.ts`, in `REFUND_CAUSES`, after the `damaged` entry:

```ts
  {
    key: "wrong_item",
    label: "The wrong thing arrived",
    needsItems: true,
    // Says what she is owed for, not what turned up instead: the substitute is
    // the shop's problem and naming it invites a question she cannot answer.
    line: "{itemsList} was not what arrived, so we are not sending it.",
  },
```

- [ ] **Step 3: Typecheck and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no output from tsc; all tests pass. `lib/notice-templates.test.ts` covers the template list — if it asserts a fixed count, update that assertion.

- [ ] **Step 4: Commit**

```bash
git add lib/db/types.ts lib/notice-templates.ts
git commit -m "feat: a wrong delivery is its own refund reason

Folded into 'other' it was indistinguishable from an ongkir mistake or a
goodwill gesture, and the pending tab could not say what happened. The sentence
names what she is owed for rather than what turned up instead — the substitute
is the shop's problem, and naming it invites a question she cannot answer."
```

---

### Task 3: The shared step both marks call

**Files:**
- Create: `lib/db/mark-refunds.ts`
- Test: `lib/db/mark-refunds.test.ts`

**Interfaces:**
- Consumes: `owed` (Task 1); `getPaymentStatus` from `./finance`; `sendInvoiceNotice` from `./notices`; `fillNotice`, `NOTICE_TEMPLATES`, `REFUND_CAUSES` from `../notice-templates`; `normalizeId` from `./helpers`.
- Produces:
  - `type MarkReduction = { customer: string; unitsRemoved: number; unitPrice: number }`
  - `refundForReduction(event: string, reason: string, itemsLabel: string, reductions: MarkReduction[], actor?: string | null): Promise<{ customer: string; amount: number; refundId: number }[]>`

- [ ] **Step 1: Write the failing test**

Create `lib/db/mark-refunds.test.ts`:

```ts
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { refundForReduction } from "./mark-refunds"
import { getRefunds } from "./finance"

const TAG = `marktest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const PAID = `${TAG}_paid`
const UNPAID = `${TAG}_unpaid`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products WHERE COALESCE(gram,0) = 0 ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  for (const who of [PAID, UNPAID]) {
    await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
    // Three units at 100_000; the mark below removes two from each.
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${EVENT}, ${who}, ${productId}, 100000, 1)`
  }
  // Only one of them has transferred anything.
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${PAID}, 100000, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM announcements WHERE event = ${EVENT}`
  await sql`DELETE FROM refunds WHERE event = ${EVENT}`
  await sql`DELETE FROM payments WHERE event = ${EVENT}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("only the customer who paid is refunded", async () => {
  // Both orders shrink to zero. The unpaid one simply owes less.
  await sql`UPDATE orders SET unit = 0 WHERE event = ${EVENT}`
  const made = await refundForReduction(EVENT, "unavailable", "Test Product", [
    { customer: PAID, unitsRemoved: 1, unitPrice: 100000 },
    { customer: UNPAID, unitsRemoved: 1, unitPrice: 100000 },
  ], "tester")

  assert.equal(made.length, 1, "one refund, not two")
  assert.equal(made[0].amount, 100000)

  const rows = await getRefunds({ event: EVENT })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reason, "unavailable")
  assert.equal(rows[0].status, "pending")
})

test("the customer is told, in the same breath", async () => {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM announcements
     WHERE event = ${EVENT} AND customer_id IN (
       SELECT id FROM customers WHERE instagram_id = ${PAID}
     )`
  assert.ok(Number(rows[0].n) >= 1, "a refund nobody is told about is a promise nobody made")
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/mark-refunds.test.ts`
Expected: FAIL — `Cannot find module './mark-refunds'`

- [ ] **Step 3: Check what a notice needs before writing the call**

Run: `grep -n "notifyCustomer" -A 12 lib/db/announcements.ts | head -20`

`sendInvoiceNotice` calls it; confirm whether it wants a customer id or a handle, and whether an unknown customer throws. Write Step 4 to match what you find — the test above asserts a row in `announcements` for the paid customer.

- [ ] **Step 4: Write the implementation**

Create `lib/db/mark-refunds.ts`:

```ts
import { getPaymentStatus } from "./finance"
import { sendInvoiceNotice } from "./notices"
import { normalizeId } from "./helpers"
import { owed } from "./refund-owed"
import { fillNotice, NOTICE_TEMPLATES, REFUND_CAUSES } from "../notice-templates"

/** One customer's share of a mark: how many of their units went, and at what price. */
export type MarkReduction = {
  customer: string
  unitsRemoved: number
  unitPrice: number
}

/**
 * Turn a mark's reductions into refunds, and tell each customer.
 *
 * Called after the units have already come off the orders, because the amount
 * depends on the invoice as it now stands: a reduction only owes money to
 * somebody whose payment has become surplus. Somebody who had not paid simply
 * owes less, and refunding them would invent a debt.
 *
 * The refund and the notice are one action — sendInvoiceNotice writes both in a
 * single transaction, because a refund nobody is told about is a promise nobody
 * made, and a notice without a refund promises money the system has no record
 * of.
 */
export async function refundForReduction(
  event: string,
  reason: string,
  itemsLabel: string,
  reductions: MarkReduction[],
  actor?: string | null,
): Promise<{ customer: string; amount: number; refundId: number }[]> {
  if (reductions.length === 0) return []

  const statuses = await getPaymentStatus(event)
  const byCustomer = new Map(statuses.map((s) => [normalizeId(s.customer), s]))

  const cause = REFUND_CAUSES.find((c) => c.key === reason)
  const template = NOTICE_TEMPLATES.find((t) => t.key === "inbox_refund_offered")!

  const made: { customer: string; amount: number; refundId: number }[] = []

  for (const r of reductions) {
    const status = byCustomer.get(normalizeId(r.customer))
    if (!status) continue
    const amount = owed(r.unitsRemoved, r.unitPrice, status.totalPaid, status.invoiceTotal)
    if (amount <= 0) continue

    const tokens = {
      "{customer}": r.customer,
      "{event}": event,
      "{refundAmount}": `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`,
      "{itemsList}": `${itemsLabel} × ${r.unitsRemoved}`,
      "{cause}": "",
    }
    const causeLine = cause ? fillNotice(cause.line, tokens) : ""

    const { refundId } = await sendInvoiceNotice({
      event,
      customer: r.customer,
      title: fillNotice(template.title, tokens),
      body: fillNotice(template.body, { ...tokens, "{cause}": causeLine }),
      refund: {
        cause: reason,
        amount,
        affectedUnits: r.unitsRemoved,
        items: `${itemsLabel} × ${r.unitsRemoved}`,
      },
    })
    if (refundId) made.push({ customer: r.customer, amount, refundId })
  }

  return made
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/mark-refunds.test.ts`
Expected: PASS, 2 tests. If `sendInvoiceNotice` rejects the reason, check `REFUND_REASONS` includes it (Task 2).

- [ ] **Step 6: Commit**

```bash
git add lib/db/mark-refunds.ts lib/db/mark-refunds.test.ts
git commit -m "feat: a reduction becomes a refund and a message together

Called after the units have come off, because the amount depends on the invoice
as it now stands: a reduction owes money only to somebody whose payment has
become surplus. Somebody who had not paid simply owes less.

sendInvoiceNotice already writes the refund and the notice in one transaction —
a refund nobody is told about is a promise nobody made."
```

---

### Task 4: The Shopping List mark

**Files:**
- Modify: `lib/db/shopping-list.ts` — `markProductOutOfStock`, lines 344–395

**Interfaces:**
- Consumes: `refundForReduction` (Task 3).
- Produces: `markProductOutOfStock` returns `{ reducedOrderIds, reducedUnits, refunds }` — the third field is what Task 3 returned. Existing callers ignore it; the return type widens rather than changes.

- [ ] **Step 1: Write the failing test**

Append to `lib/db/mark-refunds.test.ts`:

```ts
import { markProductOutOfStock } from "./shopping-list"

test("marking sold out refunds the customer who paid", async () => {
  const EV = `${TAG}_SOLD`
  const who = `${TAG}_sold_paid`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EV}, ${who}, ${productId}, 100000, 2)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${who}, 200000, true, 'deposit')`

  const result = await markProductOutOfStock(
    { event: EV, productId, quantityOutOfStock: 1 }, "tester")

  assert.equal(result.reducedUnits, 1)
  assert.equal(result.refunds.length, 1)
  assert.equal(result.refunds[0].amount, 100000)

  const rows = await getRefunds({ event: EV })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reason, "unavailable")

  await sql`DELETE FROM announcements WHERE event = ${EV}`
  await sql`DELETE FROM refunds WHERE event = ${EV}`
  await sql`DELETE FROM payments WHERE event = ${EV}`
  await sql`DELETE FROM orders WHERE event = ${EV}`
  await sql`DELETE FROM events WHERE name = ${EV}`
  await sql`DELETE FROM customers WHERE instagram_id = ${who}`
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/mark-refunds.test.ts`
Expected: FAIL — `result.refunds` is undefined.

- [ ] **Step 3: Wire the mark**

In `lib/db/shopping-list.ts`, widen the return type and, after the existing `sql.begin` block that reduces the units, add the refund step. It runs after the transaction commits, because the amount is read from the invoice as it now stands:

```ts
}, actor?: string | null): Promise<{
  reducedOrderIds: number[]
  reducedUnits: number
  refunds: { customer: string; amount: number; refundId: number }[]
}> {
```

Collect each customer's share while allocating — inside the loop that already pushes to `reducedOrderIds`:

```ts
      reductions.push({ customer: o.customer, unitsRemoved: allocated, unitPrice: o.unitPrice })
```

That needs `unit_price` in the SELECT at the top of the function and on `type Row`:

```ts
  type Row = { id: number; customer: string; unit: number; unitBuy: number; pending: number; unitPrice: number }
```
```sql
      COALESCE(unit_price, 0)::int AS "unitPrice",
```

Then, after the transaction:

```ts
  // After the commit, deliberately: the amount owed depends on the invoice as
  // it now stands, and a customer who had not paid is owed nothing.
  const name = await productName(data.productId)
  const refunds = await refundForReduction(data.event, "unavailable", name, reductions, actor)

  return { reducedOrderIds, reducedUnits, refunds }
```

`productName` does not exist yet — add it above, or inline the lookup:

```ts
const [p] = await sql<{ name: string }[]>`SELECT name FROM products WHERE id = ${data.productId}`
const name = p?.name ?? "the item"
```

Import at the top: `import { refundForReduction } from "./mark-refunds"`.

- [ ] **Step 4: Run and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/mark-refunds.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Full suite and typecheck**

Run: `npx tsc --noEmit && npm test`

- [ ] **Step 6: Commit**

```bash
git add lib/db/shopping-list.ts lib/db/mark-refunds.test.ts
git commit -m "feat: marking an item sold out refunds whoever paid for it

It reduced the order and stopped. The customer's invoice fell, their payment
did not, and the gap was left for arithmetic to notice days later and label
'overpayment' — a word that says nothing about the item nobody could buy, on a
row she was never told about.

The refund now carries the reason and goes out with the message, at the moment
somebody knew the reason."
```

---

### Task 5: The Receiving List marks

**Files:**
- Modify: `lib/db/fulfillment.ts` — `recordNotReceived`, from line 1277

**Interfaces:**
- Consumes: `refundForReduction` (Task 3).
- Produces: `NotReceivedResult` gains `refunds: { customer: string; amount: number; refundId: number }[]`.

- [ ] **Step 1: Write the failing test**

Append to `lib/db/mark-refunds.test.ts`:

```ts
import { recordNotReceived } from "./fulfillment"

test("a missing parcel refunds the customer who paid, as shipping_loss", async () => {
  const EV = `${TAG}_MISS`
  const who = `${TAG}_miss_paid`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch)
    VALUES (${EV}, ${who}, ${productId}, 100000, 2, 2, 2)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${who}, 200000, true, 'deposit')`

  const [prod] = await sql<{ name: string }[]>`SELECT name FROM products WHERE id = ${productId}`
  const result = await recordNotReceived(
    { event: EV, productId, productName: prod.name, qty: 1, mode: "missing" }, "tester")

  assert.equal(result.refunds.length, 1)
  assert.equal(result.refunds[0].amount, 100000)
  const rows = await getRefunds({ event: EV })
  assert.equal(rows[0].reason, "shipping_loss")

  await sql`DELETE FROM announcements WHERE event = ${EV}`
  await sql`DELETE FROM refunds WHERE event = ${EV}`
  await sql`DELETE FROM excess_purchase WHERE event = ${EV}`
  await sql`DELETE FROM payments WHERE event = ${EV}`
  await sql`DELETE FROM orders WHERE event = ${EV}`
  await sql`DELETE FROM events WHERE name = ${EV}`
  await sql`DELETE FROM customers WHERE instagram_id = ${who}`
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/mark-refunds.test.ts`
Expected: FAIL — `result.refunds` is undefined.

- [ ] **Step 3: Wire the marks**

Read `recordNotReceived` in full first (`sed -n '1277,1400p' lib/db/fulfillment.ts`) — it handles four modes and writes different `excess_purchase` rows for each. Collect the per-customer reductions the same way the existing code tracks which orders it touched, then after its transaction:

```ts
  // cancelled is the customer's own doing and is handled by the cancellation
  // flow — it creates no refund here.
  const REASON_FOR: Record<string, string | null> = {
    missing: "shipping_loss",
    broken: "damaged",
    wrong: "wrong_item",
    cancelled: null,
  }
  const reason = REASON_FOR[data.mode]
  const refunds = reason
    ? await refundForReduction(data.event, reason, data.productName, reductions, actor)
    : []
```

Add `refunds` to the returned object and to `NotReceivedResult` in the same file.

Import at the top: `import { refundForReduction } from "./mark-refunds"`.

- [ ] **Step 4: Run and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/mark-refunds.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Full suite, typecheck, build**

```bash
npx tsc --noEmit && npm test && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add lib/db/fulfillment.ts lib/db/mark-refunds.test.ts
git commit -m "feat: a parcel lost, broken or wrong refunds whoever paid for it

Three marks, three reasons — shipping_loss, damaged, wrong_item — each written
at the moment somebody knew which it was, and each going out with the message
that says so. A cancellation still creates nothing: that is the customer's own
doing and has its own flow.

Same rule as the shopping list: only a customer whose payment has become
surplus is owed anything."
```

---

### Task 6: See it work on real data

**Files:**
- Modify: `scripts/seed-refund-scenarios.ts`

- [ ] **Step 1: Give the seed a customer to mark**

Add a customer with a multi-unit paid order, so marking part of it sold out
produces a partial refund rather than the whole line:

```ts
  { handle: `${TAG}_markme`, ordered: 300_000, paid: 300_000, why: "3 units paid — mark 1 sold out to see a partial refund" },
```

The seed writes one unit per order; change that person's insert to three units
at 100_000 each so a partial mark is possible.

- [ ] **Step 2: Re-seed and mark by hand**

```bash
npx tsx --env-file-if-exists=.env.development.local scripts/seed-refund-scenarios.ts
npm run dev
```

On the Shopping List, mark 1 of `SEEDRF_markme`'s 3 units sold out. Then check:
- Refunds → Pending has an `unavailable` row for Rp 100.000
- the customer's inbox has a notice saying the item could not be bought
- Refunds → To check does **not** also list them for the same money

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-refund-scenarios.ts
git commit -m "chore: a seeded customer to mark sold out

Three paid units, so marking one shows a partial refund rather than a line
disappearing whole — which is what actually happens and the case most likely to
be got wrong."
```

---

## Self-Review

**Spec coverage.** Marks create refunds with their own reasons — Tasks 4 and 5. `wrong_item` as a distinct reason — Task 2. Paid-only rule — Task 1, enforced in Task 3. Notice sent automatically in the same transaction — Task 3. `cancelled` creates nothing — Task 5.

**Dropped from the spec, with reason:** "undoing a mark cancels its refund" — neither mark has an undo path, so there is nothing to undo. Recorded here rather than silently skipped.

**Types.** `MarkReduction` and the `{ customer, amount, refundId }[]` return shape are used identically in Tasks 3, 4 and 5. `owed(unitsRemoved, unitPrice, totalPaid, invoiceTotalAfter)` is called only from Task 3.

**Soft spots, flagged not hidden.** Task 3 Step 3 says to check what `notifyCustomer` wants before writing the notice call. Task 5 Step 3 says to read `recordNotReceived` in full before editing it — it handles four modes with different `excess_purchase` writes, and the per-customer reductions have to be collected from whichever branch ran.
