# Parcel Plan Ongkir Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make what the parcels actually cost reach the invoice — a fee when a split adds a parcel, a credit when a merge removes one, and the difference when the courier disagrees with the estimate.

**Architecture:** One adjustment row per customer, owned by the system and kept equal to what `parcelPlanExtra` currently says. Every path that can change a plan calls one reconciler, which creates, updates or deletes that row. No undo paths: un-merging is a recompute that reaches a different number.

**Tech Stack:** Next.js 16 App Router, TypeScript, postgres.js, Supabase Postgres, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-08-27-parcel-plan-ongkir-design.md`

## Global Constraints

- **Never touch a row a person typed.** The reconciler reads and writes only `adjustments.auto = true`. This is the single most important rule in the plan: the owner has nine hand-typed discounts in production and one of them is worded exactly like the system's own.
- **Zero is silence.** A plan costing nothing writes no row, and deletes one that exists. Rounding absorbs most splits; those must produce nothing at all.
- **The customer is told, in the same transaction.** Every automatic adjustment sends a notice via `sendInvoiceNotice`. She never sees an adjustment's description — the WhatsApp invoice lumps them into `Biaya Lainnya` and her catalogue page reads aggregates — so the notice is the only surface that explains itself.
- **Money actions confirm.** No silent save on anything that changes what a customer owes.
- **Migrations are applied by hand** in the Supabase SQL editor as the postgres owner. Never run `supabase db reset` on the dev database.
- **Descriptions, exactly:** `Ongkir kirim duluan`, `Gabung ongkir dengan {EVENT}`, `Selisih ongkir JNE ({from} kg → {to} kg)`.
- Run `npm test` and `npm run build` before every commit.

---

### Task 1: The three columns

**Files:**
- Create: `supabase/migrations/116_parcel_plan_ongkir.sql`

**Interfaces:**
- Produces: `adjustments.auto boolean NOT NULL DEFAULT false`, `customer_shipping_prefs.set_by text NOT NULL DEFAULT 'customer'`, `shipments.weight_charged integer NULL`

- [ ] **Step 1: Write the migration**

```sql
-- What the parcels really cost, and who decided it.
--
-- adjustments.auto marks a row the system owns. The reconciler reads and
-- writes only its own, because the owner has been doing this by hand for
-- months and one of her nine discounts is worded exactly like the system's.
-- Matching on the description would rewrite it and say nothing.
ALTER TABLE adjustments ADD COLUMN auto boolean NOT NULL DEFAULT false;

-- Existing rows are all hers, which the default already says. Stated here so
-- a reader does not have to work it out.
COMMENT ON COLUMN adjustments.auto IS
  'True when the parcel-plan reconciler owns this row. Never set by hand.';

-- Who chose the shipping plan. A staff-recorded merge that looks like the
-- customer''s own invites her to change it, undoing a parcel already packed.
ALTER TABLE customer_shipping_prefs
  ADD COLUMN set_by text NOT NULL DEFAULT 'customer';

ALTER TABLE customer_shipping_prefs
  ADD CONSTRAINT customer_shipping_prefs_set_by_check
  CHECK (set_by IN ('customer', 'shop'));

-- What the courier actually charged, when it disagreed with the estimate.
-- NULL means it did not, which is most parcels and needs nothing recorded.
-- weight_estimation already holds CEIL(kg) — billed kilos, not grams — so
-- this is a whole number off the receipt.
ALTER TABLE shipments ADD COLUMN weight_charged integer;

-- Finding the reconciler's rows for one customer is the hot path.
CREATE INDEX IF NOT EXISTS idx_adjustments_auto
  ON adjustments (event, customer) WHERE auto;
```

- [ ] **Step 2: Apply it to the dev database**

Run:
```bash
npx tsx --env-file-if-exists=.env.development.local -e '
import fs from "node:fs"; import sql from "./lib/db-pool"
await sql.unsafe(fs.readFileSync("supabase/migrations/116_parcel_plan_ongkir.sql","utf8"))
console.log(await sql`SELECT auto FROM adjustments LIMIT 1`)
await sql.end()'
```
Expected: prints a row with `auto: false`, no error.

- [ ] **Step 3: Verify no existing row was claimed**

Run:
```bash
npx tsx --env-file-if-exists=.env.development.local -e '
import sql from "./lib/db-pool"
console.log(await sql`SELECT count(*)::int AS wrongly_claimed FROM adjustments WHERE auto`)
await sql.end()'
```
Expected: `wrongly_claimed: 0`. Every pre-existing adjustment belongs to the owner.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/116_parcel_plan_ongkir.sql
git commit -m "feat: columns for the parcel plan's own adjustments"
```

---

### Task 2: The reconciler

**Files:**
- Create: `lib/db/parcel-plan.ts`
- Create: `lib/db/parcel-plan.test.ts`

**Interfaces:**
- Consumes: `parcelPlanExtra(events, ongkirPerKg)` from `lib/db/helpers.ts`; `normalizeId` from `lib/db/helpers.ts`
- Produces:
  ```ts
  export type PlanRow = { description: string; amount: number }
  export function planAdjustment(extra: number, partnerEvent: string | null): PlanRow | null
  export async function reconcileParcelPlan(
    customer: string, event: string, db?: DBExecutor,
  ): Promise<{ description: string; amount: number } | null>
  ```

- [ ] **Step 1: Write the failing test for the pure part**

```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { planAdjustment } from "./parcel-plan"

test("a plan that costs nothing writes nothing", () => {
  // Rounding absorbs most splits. Silence is the correct output, not a zero row.
  assert.equal(planAdjustment(0, null), null)
})

test("an extra parcel is a fee, named for what it is", () => {
  assert.deepEqual(planAdjustment(25_000, null), {
    description: "Ongkir kirim duluan", amount: 25_000,
  })
})

test("a merge is a credit, named for the trip it merged with", () => {
  // The owner's own wording, kept: it says which trip, where "Diskon ongkir"
  // would leave her guessing weeks later.
  assert.deepEqual(planAdjustment(-14_000, "LSCN202606"), {
    description: "Gabung ongkir dengan LSCN202606", amount: -14_000,
  })
})

test("a credit with no partner named still says something useful", () => {
  assert.deepEqual(planAdjustment(-9_000, null), {
    description: "Diskon gabung ongkir", amount: -9_000,
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test lib/db/parcel-plan.test.ts`
Expected: FAIL — `Cannot find module './parcel-plan'`

- [ ] **Step 3: Write the pure part**

```ts
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { normalizeId, parcelPlanExtra } from "./helpers"

export type PlanRow = { description: string; amount: number }

/**
 * The adjustment a plan is owed, or null when it is owed nothing.
 *
 * Zero is silence rather than a zero-amount row: the rounding absorbs most
 * splits, and a line saying "Rp 0" on someone's invoice is a question she
 * should not have to ask.
 */
export function planAdjustment(extra: number, partnerEvent: string | null): PlanRow | null {
  if (extra === 0) return null
  if (extra > 0) return { description: "Ongkir kirim duluan", amount: extra }
  return {
    description: partnerEvent ? `Gabung ongkir dengan ${partnerEvent}` : "Diskon gabung ongkir",
    amount: extra,
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test lib/db/parcel-plan.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing test for the database part**

Append to `lib/db/parcel-plan.test.ts`:

```ts
import { before, after } from "node:test"
import sql from "../db-pool"
import { reconcileParcelPlan } from "./parcel-plan"

const TAG = "planrec"
const EVENT = `${TAG}_EV`
const WHO = `${TAG}_c`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price)
    VALUES (${`${TAG} item`}, ${TAG}, 500, 0) RETURNING id`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    SELECT ${c.id}, id, 25000 FROM warehouses ORDER BY id LIMIT 1`
  // 1 kg in two halves: split it and each parcel rounds to 1 kg, so one extra.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive)
    VALUES (${EVENT}, ${WHO}, ${productId}, 100000, 2, 2, 2, 1)`
})

after(async () => {
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id = ${WHO})`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id = ${WHO})`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${WHO}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

async function autoRows() {
  return await sql<{ description: string; amount: number }[]>`
    SELECT description, amount FROM adjustments
     WHERE event = ${EVENT} AND auto ORDER BY id`
}

test("no declared plan means no row", async () => {
  await reconcileParcelPlan(WHO, EVENT)
  assert.deepEqual(await autoRows(), [])
})

test("declaring a split writes the fee", async () => {
  await sql`
    UPDATE customer_shipping_prefs SET mode = 'split' WHERE event = ${EVENT}`
  await sql`
    INSERT INTO customer_shipping_prefs (customer_id, event, mode, set_by)
    SELECT id, ${EVENT}, 'split', 'shop' FROM customers WHERE instagram_id = ${WHO}
    ON CONFLICT (customer_id, event) DO UPDATE SET mode = 'split', set_by = 'shop'`
  await reconcileParcelPlan(WHO, EVENT)
  assert.deepEqual(await autoRows(), [{ description: "Ongkir kirim duluan", amount: 25000 }])
})

test("running it again changes nothing", async () => {
  // Idempotence is the whole contract: it runs on every arrival and every
  // press, and must never stack rows or double an amount.
  await reconcileParcelPlan(WHO, EVENT)
  await reconcileParcelPlan(WHO, EVENT)
  assert.deepEqual(await autoRows(), [{ description: "Ongkir kirim duluan", amount: 25000 }])
})

test("clearing the plan removes the row", async () => {
  await sql`
    UPDATE customer_shipping_prefs SET mode = 'wait'
     WHERE customer_id IN (SELECT id FROM customers WHERE instagram_id = ${WHO})`
  await reconcileParcelPlan(WHO, EVENT)
  assert.deepEqual(await autoRows(), [])
})

test("a row somebody typed is invisible to it, even worded identically", async () => {
  // The reason adjustments.auto exists. This must never be touched.
  await sql`
    INSERT INTO adjustments (event, customer, description, amount, auto)
    VALUES (${EVENT}, ${WHO}, 'Ongkir kirim duluan', 99000, false)`
  await reconcileParcelPlan(WHO, EVENT)
  const [mine] = await sql<{ amount: number }[]>`
    SELECT amount FROM adjustments WHERE event = ${EVENT} AND NOT auto`
  assert.equal(mine.amount, 99000, "the owner's row was rewritten")
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/parcel-plan.test.ts`
Expected: FAIL — `reconcileParcelPlan is not a function`

- [ ] **Step 7: Write the reconciler**

Append to `lib/db/parcel-plan.ts`:

```ts
/**
 * Make the system's adjustment equal what this customer's plan now costs.
 *
 * Derived state, not an event. Un-merging is not an undo path — it is this
 * function reaching a different number. That is why there is no history to
 * unwind and no ordering to get wrong.
 *
 * Scoped to one customer: a reconcile triggered by one person's arrival must
 * not rewrite another's row.
 *
 * Returns the row as it now stands, or null when the plan costs nothing.
 */
export async function reconcileParcelPlan(
  customer: string,
  event: string,
  db: DBExecutor = sql,
): Promise<PlanRow | null> {
  const key = normalizeId(customer)

  // Every trip in this customer's plan: the named one, plus anything sharing
  // its merge group. A pairing is priced as one parcel, so it has to be
  // gathered before the arithmetic, not after.
  const trips = (await db`
    WITH me AS (
      SELECT id FROM customers WHERE lower(replace(instagram_id, '@', '')) = ${key}
    ),
    grp AS (
      SELECT merge_key FROM customer_shipping_prefs
       WHERE customer_id = (SELECT id FROM me) AND event = ${event} AND merge_key IS NOT NULL
    )
    SELECT p.event, p.mode, p.merge_key
      FROM customer_shipping_prefs p
     WHERE p.customer_id = (SELECT id FROM me)
       AND (p.event = ${event}
            OR (p.merge_key IS NOT NULL AND p.merge_key = (SELECT merge_key FROM grp)))
  `) as unknown as { event: string; mode: string | null; merge_key: string | null }[]

  const events = trips.length ? trips.map((t) => t.event) : [event]
  const merged = trips.some((t) => t.merge_key) && events.length > 1
  const splitting = trips.some((t) => t.mode === "split")

  const [rate] = (await db`
    SELECT COALESCE(cwo.ongkos_kirim, 0)::int AS ongkir
      FROM events ev
      JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
      JOIN customers c ON c.id = cwo.customer_id
     WHERE ev.name = ${event}
       AND lower(replace(c.instagram_id, '@', '')) = ${key}
  `) as unknown as { ongkir: number }[]
  const ongkirPerKg = Number(rate?.ongkir ?? 0)

  const lines = (await db`
    SELECT o.event, COALESCE(p.gram, 0)::int AS gram, o.unit::int AS unit,
           -- What actually travels in the early parcel. Only a declared split
           -- sends part of an order; otherwise the whole line goes at once.
           GREATEST(COALESCE(o.unit_arrive, 0) - COALESCE(o.unit_ship, 0), 0)::int AS arrived
      FROM orders o JOIN products p ON p.id = o.product_id
     WHERE o.event = ANY(${events})
       AND lower(replace(o.customer, '@', '')) = ${key}
       AND o.unit > 0
  `) as unknown as { event: string; gram: number; unit: number; arrived: number }[]

  const byEvent = new Map<string, { gram: number; unit: number; toShip: number }[]>()
  for (const l of lines) {
    const list = byEvent.get(l.event) ?? []
    list.push({ gram: l.gram, unit: l.unit, toShip: splitting ? Math.min(l.arrived, l.unit) : l.unit })
    byEvent.set(l.event, list)
  }

  // A merge is one parcel for the whole group, so its weight is summed before
  // rounding rather than after — which is exactly where the saving comes from.
  const grouped = merged
    ? [{ lines: [...byEvent.values()].flat() }]
    : [...byEvent.values()].map((l) => ({ lines: l }))

  const invoicedKg = [...byEvent.values()].reduce(
    (kg, l) => kg + Math.ceil(l.reduce((g, x) => g + x.gram * x.unit, 0) / 1000), 0)
  const extra = merged
    ? ongkirPerKg * (Math.ceil(grouped[0].lines.reduce((g, x) => g + x.gram * x.unit, 0) / 1000) - invoicedKg)
    : parcelPlanExtra(grouped, ongkirPerKg)

  const partner = merged ? events.filter((e) => e !== event).sort()[0] ?? null : null
  const wanted = planAdjustment(extra, partner)

  // Only ever its own row. A description matching by accident is not enough —
  // see the test that plants one.
  const [existing] = (await db`
    SELECT id, description, amount FROM adjustments
     WHERE event = ${event} AND lower(replace(customer, '@', '')) = ${key}
       AND auto AND description NOT LIKE 'Selisih ongkir JNE%'
     ORDER BY id LIMIT 1
  `) as unknown as { id: number; description: string; amount: number }[]

  if (!wanted) {
    if (existing) await db`DELETE FROM adjustments WHERE id = ${existing.id}`
    return null
  }
  if (!existing) {
    await db`
      INSERT INTO adjustments (event, customer, description, amount, auto)
      VALUES (${event}, ${customer}, ${wanted.description}, ${wanted.amount}, true)`
    return wanted
  }
  if (existing.amount !== wanted.amount || existing.description !== wanted.description) {
    await db`
      UPDATE adjustments SET description = ${wanted.description}, amount = ${wanted.amount},
             updated_at = NOW()
       WHERE id = ${existing.id}`
  }
  return wanted
}
```

- [ ] **Step 8: Run it and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/parcel-plan.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 9: Run the whole suite and build**

Run: `npm test && npm run build`
Expected: all tests pass, build compiles.

- [ ] **Step 10: Commit**

```bash
git add lib/db/parcel-plan.ts lib/db/parcel-plan.test.ts
git commit -m "feat: one reconciler for what a parcel plan costs"
```

---

### Task 3: Staff declare a split or a merge

**Files:**
- Modify: `lib/db/shipping-prefs.ts` — `setShippingMode` and `setMergeGroup` accept `setBy`
- Create: `app/api/sheets/ship/plan/route.ts`
- Create: `lib/db/parcel-plan-prefs.test.ts`

**Interfaces:**
- Consumes: `reconcileParcelPlan(customer, event, db?)` from Task 2
- Produces:
  ```ts
  // setShippingMode(customerId, event, mode, db?, setBy?: "customer" | "shop")
  // setMergeGroup(customerId, events, db?, setBy?: "customer" | "shop")
  // POST /api/sheets/ship/plan { action: "split" | "unsplit" | "merge" | "unmerge",
  //                              customer: string, events: string[] }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { setShippingMode } from "./shipping-prefs"

test("a plan the shop recorded says so", async () => {
  // Without this her page shows a choice she never made, and the first thing
  // she might do is change it — undoing a parcel already packed.
  const [c] = await sql<{ id: number }[]>`
    SELECT id FROM customers WHERE instagram_id = 'prefsby_c'`
  await setShippingMode(c.id, "prefsby_EV", "split", sql, "shop")
  const [row] = await sql<{ set_by: string }[]>`
    SELECT set_by FROM customer_shipping_prefs
     WHERE customer_id = ${c.id} AND event = 'prefsby_EV'`
  assert.equal(row.set_by, "shop")
})

test("the customer's own choice is still hers", async () => {
  const [c] = await sql<{ id: number }[]>`
    SELECT id FROM customers WHERE instagram_id = 'prefsby_c'`
  await setShippingMode(c.id, "prefsby_EV", "wait")
  const [row] = await sql<{ set_by: string }[]>`
    SELECT set_by FROM customer_shipping_prefs
     WHERE customer_id = ${c.id} AND event = 'prefsby_EV'`
  assert.equal(row.set_by, "customer")
})
```

Write the same `before`/`after` fixture as Task 2 Step 5, with `TAG = "prefsby"`, an order of 2 units at 500 g, `unit_arrive = 1`, and an ongkir rate of 25000.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/parcel-plan-prefs.test.ts`
Expected: FAIL — `setShippingMode` takes 4 arguments, not 5.

- [ ] **Step 3: Add the failing test for the payment check**

Append to `lib/db/parcel-plan-prefs.test.ts`:

```ts
test("the shop may plan a parcel for a customer who still owes", async () => {
  // A merge is arranged BEFORE she pays — that is the point, so the discount
  // reaches the invoice she settles. The unpaid rule is a policy about what a
  // customer may do on her own, and the shop is not a customer.
  const [c] = await sql<{ id: number }[]>`
    SELECT id FROM customers WHERE instagram_id = 'prefsby_c'`
  await sql`DELETE FROM payments WHERE event = 'prefsby_EV'`   // she owes everything
  await setShippingMode(c.id, "prefsby_EV", "split", sql, "shop")
  const [row] = await sql<{ mode: string }[]>`
    SELECT mode FROM customer_shipping_prefs WHERE customer_id = ${c.id} AND event = 'prefsby_EV'`
  assert.equal(row.mode, "split")
})

test("the customer herself is still stopped by it", async () => {
  const [c] = await sql<{ id: number }[]>`
    SELECT id FROM customers WHERE instagram_id = 'prefsby_c'`
  await assert.rejects(() => setShippingMode(c.id, "prefsby_EV", "split"), /unpaid/)
})

test("a parcel that already shipped stops the shop too", async () => {
  // Not a policy — the box has gone. Nobody may re-plan it.
  await sql`UPDATE orders SET unit_ship = unit WHERE event = 'prefsby_EV'`
  await assert.rejects(
    () => setShippingMode(c.id, "prefsby_EV", "split", sql, "shop"), /shipped/)
  await sql`UPDATE orders SET unit_ship = 0 WHERE event = 'prefsby_EV'`
})
```

- [ ] **Step 4: Run it and watch the first one fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/parcel-plan-prefs.test.ts`
Expected: FAIL — `ShippingPrefError: unpaid`. That refusal is the bug.

- [ ] **Step 5: Thread `setBy` through both writers**

In `lib/db/shipping-prefs.ts`, change the signature and the upsert:

```ts
export async function setShippingMode(
  customerId: number,
  event: string,
  mode: ShipMode,
  db: DBExecutor = sql,
  /** Who chose it. The shop recording a plan is not the customer asking. */
  setBy: "customer" | "shop" = "customer",
): Promise<void> {
  const reason = await ineligibleReason(customerId, event, db)
  // "shipped" and "unknown" are facts about the world and stop everyone.
  // "unpaid" is a rule about what a customer may do on her own: the shop
  // arranges a merge precisely while she still owes, so the discount lands on
  // the invoice she settles — and a split cannot otherwise be undone, because
  // its own fee makes her unpaid.
  if (reason && !(setBy === "shop" && reason === "unpaid")) {
    throw new ShippingPrefError(reason)
  }
```

Delete the original two lines that computed `reason` and threw unconditionally.
Make the same change in `setMergeGroup`, which runs the same check per event.

```ts
  await db`
    INSERT INTO customer_shipping_prefs (customer_id, event, mode, set_by)
    VALUES (${customerId}, ${event}, ${mode}, ${setBy})
    ON CONFLICT (customer_id, event)
    DO UPDATE SET mode = ${mode}, set_by = ${setBy}, updated_at = NOW()
  `
```

Make the same two changes to `setMergeGroup`: add the fifth parameter and write `set_by` on both the UPDATE and the INSERT it already performs.

- [ ] **Step 6: Run it and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/parcel-plan-prefs.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Write the route**

Create `app/api/sheets/ship/plan/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { withActor } from "@/lib/db"
import { setShippingMode, setMergeGroup } from "@/lib/db/shipping-prefs"
import { reconcileParcelPlan } from "@/lib/db/parcel-plan"
import sql from "@/lib/db-pool"

/**
 * Staff record what the parcels are going to be.
 *
 * The customer has her own route for this; this one exists because the shop
 * decides most of them. Both write the same preference — the difference is
 * set_by, so her page can say the shop arranged it rather than showing her a
 * choice she does not remember making.
 */
export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const action = String(body.action ?? "")
    const customer = String(body.customer ?? "").trim()
    const events: string[] = Array.isArray(body.events) ? body.events.map(String) : []
    if (!customer || events.length === 0) {
      return NextResponse.json({ error: "customer and events are required" }, { status: 400 })
    }

    const [row] = await sql<{ id: number }[]>`
      SELECT id FROM customers WHERE lower(replace(instagram_id, '@', '')) =
        lower(replace(${customer}, '@', ''))`
    if (!row) return NextResponse.json({ error: "Unknown customer" }, { status: 404 })

    const applied = await withActor(session.user.email, async (tx) => {
      if (action === "split")   await setShippingMode(row.id, events[0], "split", tx, "shop")
      else if (action === "unsplit") await setShippingMode(row.id, events[0], "wait", tx, "shop")
      else if (action === "merge")   await setMergeGroup(row.id, events, tx, "shop")
      else if (action === "unmerge") await setMergeGroup(row.id, [], tx, "shop")
      else throw new Error("Unknown action")
      // After the plan is stored, so it prices what is now true.
      return await reconcileParcelPlan(customer, events[0], tx)
    })

    return NextResponse.json({ success: true, adjustment: applied })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to record the plan"
    console.error("Failed to record parcel plan:", err)
    // A refused plan (unpaid, part-shipped) is the customer's business to fix,
    // not a server fault.
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
```

- [ ] **Step 8: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add lib/db/shipping-prefs.ts lib/db/parcel-plan-prefs.test.ts app/api/sheets/ship/plan/route.ts
git commit -m "feat: staff can record a split or a merge, and it says who did"
```

---

### Task 4: The reconciler runs where plans change

**Files:**
- Modify: `lib/db/fulfillment.ts` — call it after arrivals and after marks reduce an order
- Modify: `app/api/public/catalogue/shipping-prefs/route.ts` — call it after the customer's own change
- Create: `lib/db/parcel-plan-triggers.test.ts`

**Interfaces:**
- Consumes: `reconcileParcelPlan(customer, event, db?)` from Task 2

- [ ] **Step 1: Write the failing test**

```ts
test("an arrival re-prices a declared split", async () => {
  // The plan moved without anyone pressing anything: what travels now versus
  // later just changed. A stale fee is a wrong invoice.
  await declareSplit()                       // fixture helper, writes mode='split'
  await reconcileParcelPlan(WHO, EVENT)
  const before = await autoAmount()

  await sql`UPDATE orders SET unit_arrive = 2 WHERE event = ${EVENT}`
  await markArrivedThroughTheApp()           // fixture helper, calls the real path
  const after = await autoAmount()

  assert.notEqual(after, before, "the fee did not follow the arrival")
})
```

Write `declareSplit`, `autoAmount` and `markArrivedThroughTheApp` as local helpers in the test file: `declareSplit` upserts `customer_shipping_prefs` with `mode = 'split'`; `autoAmount` selects `amount` from the auto adjustment; `markArrivedThroughTheApp` calls `markProductArrived({ event, productId, quantityArrived: 1 })` from `lib/db/fulfillment.ts`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/parcel-plan-triggers.test.ts`
Expected: FAIL — the amount is unchanged, because nothing reconciles on arrival.

- [ ] **Step 3: Call it from each trigger**

In `lib/db/fulfillment.ts`, at the end of `markProductArrived`, after its transaction commits:

```ts
  // The plan moved: what travels now versus later has changed. Priced per
  // customer the arrival touched, never the whole event — another customer's
  // adjustment is not this arrival's business.
  for (const customer of [...new Set(allocations.map(({ item }) => item.customer))]) {
    await reconcileParcelPlan(customer, data.event)
  }
```

`reapplyHoldsForArrival` two lines above already fans out over
`allocations.map(({ item }) => item.customer)` — follow it exactly, including
the destructuring, so the two read as the same idea.

Note the placement: **after** the transaction commits, not inside it. The
reconciler prices what is now true, and inside the transaction the arrival is
not yet true to a separate connection.

Do the same at the end of `recordNotReceived` and `markProductOutOfStock`, iterating the customers in their `reductions` arrays.

In `app/api/public/catalogue/shipping-prefs/route.ts`, after `setShippingMode` or `setMergeGroup` succeeds, call `reconcileParcelPlan(customer.instagramId, event)` inside the same `withActor` transaction.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/parcel-plan-triggers.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and build**

Run: `npm test && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/db/fulfillment.ts app/api/public/catalogue/shipping-prefs/route.ts lib/db/parcel-plan-triggers.test.ts
git commit -m "feat: the parcel plan re-prices itself when the plan moves"
```

---

### Task 5: The customer is told

**Files:**
- Modify: `lib/notice-templates.ts` — three wordings
- Modify: `lib/db/parcel-plan.ts` — send the notice with the adjustment
- Create: `lib/db/parcel-plan-notice.test.ts`

**Interfaces:**
- Consumes: `sendInvoiceNotice(input, db)` from `lib/db/notices.ts`
- Produces: notice keys `inbox_ongkir_extra`, `inbox_ongkir_credit`, `inbox_ongkir_reweighed`

- [ ] **Step 1: Write the failing test**

```ts
test("a fee she must pay before shipping is announced", async () => {
  // She sees the number on her invoice either way. This is the only surface
  // that says why: the WhatsApp invoice lumps every adjustment into Biaya
  // Lainnya and her catalogue page reads aggregates.
  await declareSplit()
  await reconcileParcelPlan(WHO, EVENT)
  const [n] = await sql<{ title: string; body: string }[]>`
    SELECT a.title, a.body FROM announcements a
      JOIN customers c ON c.id = a.customer_id
     WHERE c.instagram_id = ${WHO} ORDER BY a.id DESC LIMIT 1`
  assert.match(n.title, /Ongkir tambahan/)
  assert.match(n.body, /Rp 25\.000/)
})

test("an unchanged amount does not announce itself again", async () => {
  // It runs on every arrival. Telling her the same thing four times is worse
  // than not telling her at all.
  const before = await noticeCount()
  await reconcileParcelPlan(WHO, EVENT)
  await reconcileParcelPlan(WHO, EVENT)
  assert.equal(await noticeCount(), before)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/parcel-plan-notice.test.ts`
Expected: FAIL — no announcement row.

- [ ] **Step 3: Add the wordings**

In `lib/notice-templates.ts`, add to `NoticeKey` and `NOTICE_TEMPLATES`:

```ts
  {
    key: "inbox_ongkir_extra",
    label: "Extra shipping fee",
    title: "Ongkir tambahan {amount} · {event}",
    body:
      "Sebagian pesanan Anda sudah tiba dan akan kami kirim lebih dulu. Karena menjadi dua paket, "
      + "ada tambahan ongkir {amount} yang perlu diselesaikan sebelum paket berangkat.",
  },
  {
    key: "inbox_ongkir_credit",
    label: "Shipping discount",
    title: "Diskon ongkir {amount} · {event}",
    body:
      "Pesanan Anda kami gabung menjadi satu paket, sehingga ongkir berkurang {amount}. "
      + "Tagihan Anda sudah kami sesuaikan.",
  },
  {
    key: "inbox_ongkir_reweighed",
    label: "Courier weighed it heavier",
    title: "Ongkir tambahan {amount} · {event}",
    body:
      "Paket Anda ditimbang {chargedKg} kg oleh kurir, sedangkan estimasi kami {estimatedKg} kg. "
      + "Selisihnya menambah ongkir {amount} pada tagihan {event}.\n\n"
      + "Mohon maaf atas ketidaknyamanannya — berat sebenarnya baru diketahui setelah paket ditimbang.",
  },
```

Add `"{amount}"`, `"{chargedKg}"` and `"{estimatedKg}"` to `NOTICE_TOKENS`, and list the right subset against each new key in `NOTICE_TOKENS_FOR`.

- [ ] **Step 4: Send it from the reconciler**

In `reconcileParcelPlan`, after the INSERT and after an UPDATE that changed the amount — never after a no-op — call:

```ts
    await sendInvoiceNotice({
      event, customer,
      title: fillNotice(template.title, tokens),
      body: fillNotice(template.body, tokens),
    }, db)
```

with `template` chosen by the sign of `wanted.amount` and `tokens` carrying `{amount}` and `{event}`. Guard it on the amount having actually changed: an unchanged row sends nothing.

- [ ] **Step 5: Run it and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/parcel-plan-notice.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the whole suite and build**

Run: `npm test && npm run build`

- [ ] **Step 7: Commit**

```bash
git add lib/notice-templates.ts lib/db/parcel-plan.ts lib/db/parcel-plan-notice.test.ts
git commit -m "feat: an automatic ongkir change explains itself to the customer"
```

---

### Task 6: Correcting what the courier charged

**Files:**
- Modify: `app/api/sheets/shipments/route.ts` — accept `weightCharged`
- Modify: `lib/db/fulfillment.ts` — expose `weightCharged` on the shipments query
- Modify: `lib/db/types.ts` — add `weightCharged: number | null` to the shipment row type
- Create: `lib/db/parcel-plan-reweigh.test.ts`

**Interfaces:**
- Produces: `PATCH /api/sheets/shipments { rowNumber, weightCharged: number | null }`

- [ ] **Step 1: Write the failing test**

```ts
test("a heavier parcel bills the difference as its own row", async () => {
  // Its own row, not an edit to the split fee: what splitting cost and what
  // the estimate missed are different facts, and folding them together hides
  // which one moved.
  await recordChargedWeight(shipmentId, 3)   // estimate was 2
  const rows = await sql<{ description: string; amount: number }[]>`
    SELECT description, amount FROM adjustments WHERE event = ${EVENT} AND auto ORDER BY id`
  assert.deepEqual(rows.map((r) => r.description), [
    "Ongkir kirim duluan",
    "Selisih ongkir JNE (2 kg → 3 kg)",
  ])
  assert.equal(rows[1].amount, 25000)
})

test("correcting it back removes the difference", async () => {
  await recordChargedWeight(shipmentId, null)
  const rows = await sql`SELECT 1 FROM adjustments
    WHERE event = ${EVENT} AND auto AND description LIKE 'Selisih ongkir JNE%'`
  assert.equal(rows.length, 0)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/parcel-plan-reweigh.test.ts`
Expected: FAIL — `recordChargedWeight` is not defined.

- [ ] **Step 3: Write it**

Add to `lib/db/parcel-plan.ts`:

```ts
/**
 * What the courier actually charged for a parcel, when it disagreed.
 *
 * NULL means it did not, which is most parcels — nothing is recorded and the
 * difference row is removed if one existed. The difference is its own
 * adjustment rather than an edit to the split fee: they answer different
 * questions, and one number could not say which had moved.
 */
export async function recordChargedWeight(
  shipmentId: number,
  chargedKg: number | null,
  actor?: string | null,
): Promise<void> {
  await withActor(actor ?? null, async (tx) => {
    const [s] = (await tx`
      UPDATE shipments SET weight_charged = ${chargedKg}, updated_at = NOW()
       WHERE id = ${shipmentId}
      RETURNING event, customer, weight_estimation::int AS estimated, ongkir::int AS rate`
    ) as unknown as { event: string; customer: string; estimated: number; rate: number }[]
    if (!s) throw new Error("Shipment not found")

    const description = chargedKg === null
      ? null
      : `Selisih ongkir JNE (${s.estimated} kg → ${chargedKg} kg)`
    const amount = chargedKg === null ? 0 : (chargedKg - s.estimated) * s.rate

    const [existing] = (await tx`
      SELECT id, amount FROM adjustments
       WHERE event = ${s.event} AND customer = ${s.customer}
         AND auto AND description LIKE 'Selisih ongkir JNE%' LIMIT 1`
    ) as unknown as { id: number; amount: number }[]

    if (!description || amount === 0) {
      if (existing) await tx`DELETE FROM adjustments WHERE id = ${existing.id}`
      return
    }
    if (existing) {
      await tx`UPDATE adjustments SET description = ${description}, amount = ${amount},
               updated_at = NOW() WHERE id = ${existing.id}`
    } else {
      await tx`INSERT INTO adjustments (event, customer, description, amount, auto)
               VALUES (${s.event}, ${s.customer}, ${description}, ${amount}, true)`
    }
    // Same rule as every other automatic change: she is told, in the same
    // transaction, and told why — this one lands after her parcel has left.
    await sendInvoiceNotice({ /* inbox_ongkir_reweighed, tokens as Task 5 */ }, tx)
  })
}
```

- [ ] **Step 4: Accept it on the route**

In `app/api/sheets/shipments/route.ts`, extend the PATCH body type with `weightCharged?: number | null` and call `recordChargedWeight(rowNumber, weightCharged, session.user.email)` when the field is present. Leave `trackingNumber` and `tempAddress` handling exactly as they are.

- [ ] **Step 5: Run it and watch it pass**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/parcel-plan-reweigh.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the whole suite and build, then commit**

```bash
npm test && npm run build
git add lib/db/parcel-plan.ts lib/db/fulfillment.ts lib/db/types.ts app/api/sheets/shipments/route.ts lib/db/parcel-plan-reweigh.test.ts
git commit -m "feat: record what the courier charged, and bill the difference"
```

---

### Task 7: The two controls on the Packing List

**Files:**
- Modify: `app/dashboard/ship/ShipClient.tsx`

**Interfaces:**
- Consumes: `POST /api/sheets/ship/plan` from Task 3

- [ ] **Step 1: Add the controls**

On each customer card, replace the existing customer-request-only split block with one that renders whenever the card is partly arrived (`c.totalToShip > 0 && c.totalToShip < total units`) or the customer has another open trip:

```tsx
{/* A partly-arrived card is not a split — it is a card that could become one,
    and most never do. Nothing is priced until somebody declares the intent. */}
{canSplit && (
  <button
    type="button"
    onClick={() => postPlan(c.splitRequested ? "unsplit" : "split", [c.event])}
    disabled={planBusy}
    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
      c.splitRequested ? "bg-purple-600 text-white" : "border border-cream-border text-muted-strong"
    }`}
  >
    {c.splitRequested ? "✓ Kirim duluan" : "Kirim duluan"}
  </button>
)}
```

Add the matching **Gabung jadi 1 box** button where a customer has more than one open trip, posting `merge` with every event in the group and `unmerge` to clear it.

Show what the plan costs beside the buttons, using `c.splitExtraOngkir` — and where it is zero, say so rather than showing nothing: `Tidak ada ongkir tambahan — pembulatan berat menutupinya`.

- [ ] **Step 2: Check it by hand against the seed**

Run `npm run dev`, open `/dashboard/ship`, and confirm: pressing **Kirim duluan** on a partly-arrived card shows the fee, the invoice outstanding rises, and Kirim locks; pressing it again clears both.

- [ ] **Step 3: Build and commit**

```bash
npm run build
git add app/dashboard/ship/ShipClient.tsx
git commit -m "feat: declare a split or a merge from the Packing List"
```

---

### Task 8: The weight cell and its icon

**Files:**
- Modify: `app/dashboard/shipments/ShipmentsClient.tsx`

- [ ] **Step 1: Add the editable cell**

Follow the existing `TrackingNumberCell` pattern exactly — same inline edit, same PATCH — but confirm before saving, because this one changes what a customer owes:

```tsx
if (!confirm(`Ubah berat menjadi ${value} kg? Tagihan ${customer} akan disesuaikan.`)) return
```

- [ ] **Step 2: Add the icon**

Beside the resi, where the temporary-address marker already sits, rendered only when `row.weightCharged !== null`:

```tsx
{row.weightCharged !== null && (
  <span
    title={`Berat dikoreksi — estimasi ${row.weightEstimation} kg, ditagih ${row.weightCharged} kg`}
    className="inline-flex items-center justify-center w-[19px] h-[19px] rounded bg-red-50 text-red-700 shrink-0"
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" /><path d="M5 7h14" /><path d="m3 12 2-5 2 5a2 2 0 0 1-4 0z" /><path d="m17 12 2-5 2 5a2 2 0 0 1-4 0z" />
    </svg>
  </span>
)}
```

- [ ] **Step 3: Check it by hand**

Correct a weight on a seeded shipment; confirm the icon appears, the tooltip names both weights, and a `Selisih ongkir JNE` row lands on the Adjustments page.

- [ ] **Step 4: Build and commit**

```bash
npm run build
git add app/dashboard/shipments/ShipmentsClient.tsx
git commit -m "feat: correct a charged weight, and mark the row that was"
```

---

### Task 9: The seed, and the whole loop by hand

**Files:**
- Modify: `scripts/seed-refunds.ts` — add two customers with parcel plans worth testing

- [ ] **Step 1: Add the fixtures**

Two customers: one with a 1 kg order half-arrived (splitting charges Rp 25.000 at her rate), and one with orders on two trips whose merged weight rounds down (merging credits her). Both fully paid, so the money is visible immediately.

- [ ] **Step 2: Walk the loop**

Reseed, then: declare a split → fee appears, Kirim locks, notice sent → clear it → fee gone. Merge two trips → credit appears, named for the partner trip → unmerge → credit gone. Ship, then correct the weight → second row appears with both weights in its description.

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-refunds.ts
git commit -m "feat: seed the parcel plans worth clicking through"
```

---

## Self-review notes

Checked against the spec:

- **Three columns** → Task 1
- **Derived state, one reconciler** → Task 2
- **Triggers table** → Task 4 covers arrivals, marks, and the customer's own change; Task 3 covers staff declaring a plan; Task 6 covers a corrected weight
- **She pays before the box goes** → falls out of the existing payment gate once the fee exists; asserted by hand in Task 7 Step 2
- **Staff controls** → Tasks 3 and 7
- **Notices** → Task 5
- **Weight correction, its own row, icon** → Tasks 6 and 8
- **No override** → nothing implements one; the `auto` filter is what keeps a manual row safe, tested in Task 2 Step 5

Deliberately not covered, matching the spec's own exclusions: charging for a split the shop chose to make, changing how the invoice bills ongkir in the first place, showing descriptions to the customer, partial waivers, and backfilling the nine hand-typed discounts.
