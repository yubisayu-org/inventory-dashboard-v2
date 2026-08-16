# Claim Capture: The Two Screens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner the shop screen they count on standing in a store, and the laptop screen where a counted slot becomes a named product with real orders behind it.

**Architecture:** Two pages, not one responsive page. `/dashboard/shop` holds four things — photo, SKU list, stepper, short panel — and creates nothing. `/dashboard/wa-posts` holds everything else: claims, customer resolution, naming, prices. They share the slot list as one component and the routes built in the previous plan. Settings gains a WhatsApp panel for the groups, the bot's admin numbers, and the default pricing method new posts start on.

**Tech Stack:** Next.js 16 App Router, React client components, Tailwind, `postgres` (postgres.js), `node:test` via `tsx`.

**Spec:** [docs/superpowers/specs/2026-08-16-whatsapp-claim-capture-design.md](../specs/2026-08-16-whatsapp-claim-capture-design.md)

**Depends on:** [2026-08-16-claim-resolvers.md](2026-08-16-claim-resolvers.md), [2026-08-16-claim-capture-backend.md](2026-08-16-claim-capture-backend.md) and [2026-08-17-claim-capture-slots-and-rekap.md](2026-08-17-claim-capture-slots-and-rekap.md) — all complete.

## Decisions already made

Settled with the owner on 2026-08-16 and 2026-08-17, several of them against
mockups they reviewed. Do not relitigate mid-build.

- **Two pages, one job each.** The shop screen shows no prices, no customers and
  no Create product button, because in a shop all of that sits between the owner
  and a stepper.
- **The picture is "B+L"**, already built in `lib/whatsapp/render.ts`.
- **Counted in SKU.** Six shelf items where two split by size is eight SKU, and
  the screens say so.
- **A slot carries a working name**, typed once, creating nothing.
- **The owner's ✅ reaction on a claim means that claim was bought** — already in
  the data layer as `wa_claims.obtained`.
- **Naming is owner-only; counting and labelling are open to admins.**
- **`/mulai <store>` … `/selesai`** is how posting works. This plan builds the
  settings screen those tables need; the commands themselves are plan 3.

## Global Constraints

- Node `22.x` per `package.json` `engines`.
- Migrations start at **066**, applied by piping to psql — `supabase migration up`
  does not work on this branch:
  ```bash
  PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
  "$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f <file>
  ```
- Money is INTEGER rupiah. Positions are normalized 0..1 doubles.
- Imports are extensionless. Route handlers take `{ params }: { params: Promise<{ id: string }> }`.
- Pages use `PageShell` + `PageHeader`; lists use `SearchInput`, `EventSelect`
  and the `Pagination` exports. Do not invent new shells.
- Tests run with `npm test`. Test fixtures inserting an event must supply
  `warehouse_id`, and must delete every `products` row they create — the dev
  database is never reset.
- Customer handles are bare lowercase; use `normalizeCustomer` from
  `lib/db/helpers`. WhatsApp numbers use `normalizeNumber` from
  `lib/db/whatsapp-groups`.
- Comments explain *why*, at the density of `lib/db/fulfillment.ts`.

---

### Task 1: A separate default pricing method for WhatsApp posts

**Files:**
- Modify: `lib/product-defaults.ts`
- Modify: `lib/db/settings.ts`
- Modify: `app/api/sheets/product-defaults/route.ts`
- Modify: `app/dashboard/settings/SettingsClient.tsx`

**Interfaces:**
- Produces: `ProductDefaults.whatsappPricingMethod: PricingMethod`, readable and writable through the existing product-defaults route.

Migration 062 already added the column. This wires it through the stack so the
owner can change it, and so Task 4 of plan 3 has something to read when a post
arrives from a group.

- [ ] **Step 1: Add it to the type and its default**

In `lib/product-defaults.ts`, add to the `ProductDefaults` interface after
`defaultPricingMethod`:

```typescript
  /**
   * Which pricing method a post captured from a WhatsApp group starts on
   * (migration 062).
   *
   * Deliberately NOT defaultPricingMethod: that one decides the Add Product
   * form's opening tab, and the owner wants the two to differ — the shops they
   * photograph are priced one way and the things they type in by hand another.
   * Sharing a column would make changing either change both.
   */
  whatsappPricingMethod: PricingMethod
```

and to `DEFAULT_PRODUCT_DEFAULTS`, after `defaultPricingMethod: "overseas",`:

```typescript
  whatsappPricingMethod: "overseas",
```

- [ ] **Step 2: Read and write it**

In `lib/db/settings.ts`, add `whatsapp_pricing_method` to the SELECT list in
`getProductDefaults`:

```typescript
    SELECT profit_pct, operational_fee, packing_fee, markup_pct, tier_kurs_round_to,
           profit_margin_round_to, flat_fee, flat_fee_pct, flat_fee_min, default_country_id,
           default_pricing_method, whatsapp_pricing_method, dp_percent
    FROM product_defaults WHERE id = 1
```

and to the returned object, after `defaultPricingMethod`:

```typescript
    whatsappPricingMethod: toPricingMethod(row.whatsapp_pricing_method),
```

In `updateProductDefaults`, add the column to the INSERT list, the VALUES list
and the DO UPDATE SET block:

```typescript
      default_country_id, default_pricing_method, whatsapp_pricing_method, dp_percent, updated_at)
    VALUES (1, ${data.profitPct}, ${data.operationalFee}, ${data.packingFee}, ${data.markupPct},
      ${data.tierKursRoundTo}, ${data.profitMarginRoundTo}, ${data.flatFee}, ${data.flatFeePct},
      ${data.flatFeeMin}, ${data.defaultCountryId}, ${data.defaultPricingMethod},
      ${data.whatsappPricingMethod}, ${data.dpPercent}, NOW())
```

```typescript
      default_pricing_method = EXCLUDED.default_pricing_method,
      whatsapp_pricing_method = EXCLUDED.whatsapp_pricing_method,
```

- [ ] **Step 3: Accept it in the route**

In `app/api/sheets/product-defaults/route.ts`, beside the existing
`defaultPricingMethod` line:

```typescript
    // Same narrowing, same "only when sent" rule, separate column: the WhatsApp
    // default and the form default are edited from different cards.
    const whatsappPricingMethod = has("whatsappPricingMethod")
      ? toPricingMethod(body.whatsappPricingMethod)
      : current.whatsappPricingMethod
```

and add `whatsappPricingMethod,` to the object passed to `updateProductDefaults`.

- [ ] **Step 4: Verify end to end**

```bash
npx tsc --noEmit
```

Expected: no output.

```bash
PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "UPDATE product_defaults SET whatsapp_pricing_method = 'tier_kurs' WHERE id = 1;"
npx tsx --env-file-if-exists=.env.development.local -e '
require("./lib/db/settings").getProductDefaults().then((d) => {
  console.log("whatsapp:", d.whatsappPricingMethod, "| form:", d.defaultPricingMethod)
  process.exit(0)
})'
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "UPDATE product_defaults SET whatsapp_pricing_method = 'overseas' WHERE id = 1;"
```

Expected: `whatsapp: tier_kurs | form: overseas` — the two are independent.

- [ ] **Step 5: Commit**

```bash
git add lib/product-defaults.ts lib/db/settings.ts app/api/sheets/product-defaults/route.ts
git commit -m "feat(settings): a separate default pricing method for WhatsApp posts

Migration 062 added the column; this wires it through. It is deliberately not
default_pricing_method: that one decides the Add Product form's opening tab, and
the owner prices the shops they photograph differently from the things they type
in by hand. Sharing one column would make changing either change both."
```

---

### Task 2: Naming a slot writes what was already bought

**Files:**
- Modify: `lib/whatsapp/naming.ts`
- Modify: `lib/whatsapp/naming.test.ts`
- Create: `app/api/whatsapp/slots/[id]/name/route.ts`

**Interfaces:**
- Consumes: `listClaims` from `lib/db/claims`.
- Produces:
  - `nameSlot` gains `size` in the product name and copies each claim's `obtained` onto its order's `unit_buy`.
  - `POST /api/whatsapp/slots/{id}/name` with `{ name, valas, gram, price? }`.

The owner counts in the shop and names at the hotel, so by naming time the slot
usually already knows what was bought. Each claim maps to exactly one order, so
that number can be written straight onto it — no allocation, no second pass
through the purchasing route, and no chance of the two disagreeing.

- [ ] **Step 1: Write the failing test**

Append to `lib/whatsapp/naming.test.ts`:

```typescript
test("what was bought in the shop lands on the orders naming creates", async () => {
  const { postId, slot } = await slotWithClaims([2, 1])
  // The owner got two of the three claimed, which by paid priority went to the
  // first claim (both customers rank equally, so arrival order decides).
  await setSlotBought(slot.id, 2)

  const { productId } = await name({
    slotId: slot.id, name: `Bought Already ${process.hrtime.bigint()}`, valas: 1699, gram: 250,
  })

  const orders = await sql`
    SELECT unit, unit_buy FROM orders WHERE product_id = ${productId} ORDER BY unit DESC
  `
  assert.equal(orders.length, 2)
  assert.equal(orders[0].unit, 2)
  assert.equal(orders[0].unit_buy, 2, "the claim that got units carries them onto its order")
  assert.equal(orders[1].unit, 1)
  assert.equal(orders[1].unit_buy, 0, "the claim that missed out is recorded as unbought")
  assert.ok(postId > 0)
})

test("a size becomes part of the product name, as the catalogue spells it", async () => {
  const { postId } = await slotWithClaims([1])
  // Re-point that slot at a size, the way clustering would for "size 95".
  await sql`UPDATE wa_slots SET size = '95' WHERE post_id = ${postId}`
  const [sized] = await listSlots(postId)

  const stamp = process.hrtime.bigint()
  const { productId } = await name({
    slotId: sized.id, name: `Bear Set ${stamp}`, valas: 1699, gram: 250,
  })

  const [product] = await sql`SELECT name FROM products WHERE id = ${productId}`
  assert.equal(product.name, `Bear Set ${stamp} 95`)
})

test("a name that already ends in its size is not given it twice", async () => {
  const { postId } = await slotWithClaims([1])
  await sql`UPDATE wa_slots SET size = '95' WHERE post_id = ${postId}`
  const [sized] = await listSlots(postId)

  const stamp = process.hrtime.bigint()
  const { productId } = await name({
    slotId: sized.id, name: `Bear Set ${stamp} 95`, valas: 1699, gram: 250,
  })

  const [product] = await sql`SELECT name FROM products WHERE id = ${productId}`
  assert.equal(product.name, `Bear Set ${stamp} 95`)
})
```

and extend that file's imports:

```typescript
import { createPost, addClaim, setSlots, listSlots, setSlotBought } from "../db/claims"
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/whatsapp/naming.test.ts`
Expected: FAIL — `unit_buy` is null and the size is missing from the name.

- [ ] **Step 3: Implement**

In `lib/whatsapp/naming.ts`, replace the `addProduct` call's `name` argument and
the `appendOrders` block. First, above the transaction, build the name:

```typescript
  // The catalogue spells the variant into the product name — "Grey Set M",
  // "Outer Shawl Beige" — so a sized slot carries its size there too. Skipped
  // when the owner already typed it, which they will when copying a label.
  const trimmed = input.name.trim()
  const productName =
    slotRow.size && !trimmed.endsWith(String(slotRow.size))
      ? `${trimmed} ${slotRow.size}`
      : trimmed
```

Then in `addProduct`, use it:

```typescript
      name: productName,
```

And replace the `appendOrders` call with:

```typescript
    const orders: OrderRow[] = claims.map((claim) => ({
      event: post.event,
      customer: claim.customer as string,
      productId,
      unitPrice: priced.price,
      unit: claim.quantity,
      note: claim.note,
    }))
    await appendOrders(orders, tx)

    // The owner counted in the shop hours before naming, so the slot usually
    // already knows what was bought. Each claim became exactly one order, so
    // that number goes straight onto it — no allocation to redo, and no second
    // source of truth to drift from wa_claims.obtained.
    //
    // Matched on customer and unit because appendOrders returns nothing; both
    // are stable for the row it just inserted, and the product id makes the pair
    // unique within this call.
    for (const claim of claims) {
      if (claim.obtained <= 0) continue
      await tx`
        UPDATE orders SET unit_buy = ${claim.obtained}, updated_at = NOW()
        WHERE product_id = ${productId}
          AND customer = ${claim.customer as string}
          AND unit = ${claim.quantity}
          AND unit_buy IS DISTINCT FROM ${claim.obtained}
      `
    }
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS — everything, plus the three new naming tests.

- [ ] **Step 5: The naming route**

Create `app/api/whatsapp/slots/[id]/name/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { nameSlot } from "@/lib/whatsapp/naming"

type Params = { params: Promise<{ id: string }> }

/**
 * Turn a counted slot into a product and its orders.
 *
 * Owner-only, unlike every other route these screens use. Counting a shelf and
 * calling it "Brown Bear Set" create nothing; this creates a product, a price,
 * and an order for every customer behind the slot.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const id = Number((await params).id)
  try {
    const body = await req.json()
    if (!String(body.name ?? "").trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }

    const result = await nameSlot({
      slotId: id,
      name: String(body.name),
      valas: Number(body.valas) || 0,
      gram: Number(body.gram) || 0,
      price: body.price != null ? Number(body.price) : undefined,
    })
    return NextResponse.json(result)
  } catch (err) {
    // nameSlot refuses rather than guessing — already named, an unresolved
    // customer, no country, a Target Price post with no price. Every one of
    // those is the caller's to fix, so it is a 400 carrying the reason rather
    // than a 500 that hides it.
    if (err instanceof Error && /already named|unresolved customer|no country|needs a price|no such slot/.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error("Failed to name slot:", err)
    return NextResponse.json({ error: "Failed to name" }, { status: 500 })
  }
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no output.

```bash
git add lib/whatsapp/naming.ts lib/whatsapp/naming.test.ts app/api/whatsapp/slots
git commit -m "feat(whatsapp): naming carries the shop tally onto the orders

The owner counts standing in a shop and names hours later at the hotel, so by
naming time the slot usually already knows what was bought. Each claim becomes
exactly one order, so that number goes straight onto unit_buy — no allocation to
redo, and no second source of truth to drift from wa_claims.obtained.

A sized slot spells its size into the product name, the way the catalogue
already does it, unless the owner typed it themselves.

The route is owner-only, unlike the rest of these screens: counting a shelf
creates nothing, and this creates a product, a price and an order per customer.
nameSlot's refusals come back as 400s carrying their reason, because every one
of them is the caller's to fix."
```

---

### Task 3: Turning a WhatsApp number into a customer

**Files:**
- Create: `lib/whatsapp/identity.ts`
- Create: `lib/whatsapp/identity.test.ts`
- Create: `app/api/whatsapp/claims/[id]/route.ts`

**Interfaces:**
- Consumes: `normalizeNumber` from `lib/db/whatsapp-groups`; `normalizeCustomer` from `lib/db/helpers`.
- Produces:
  - `findCustomerByNumber(number: string): Promise<string | null>`
  - `resolveSenders(postId: number): Promise<number>` — fills in every claim whose sender is already on a customer record, returns how many it matched.
  - `linkSenderToCustomer(number: string, handle: string): Promise<void>` — the ask-once-and-remember write.
  - `PATCH /api/whatsapp/claims/{id}` with `{ customer?, quantity?, state? }`.

`customers.whatsapp` already exists, so many senders resolve with no interaction
at all. The rest are a review state, never an error, and never a reason to
invent a customer keyed by phone — that would build a second namespace beside
the Instagram handles everything else in the app depends on.

- [ ] **Step 1: Write the failing test**

Create `lib/whatsapp/identity.test.ts`:

```typescript
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { createPost, addClaim, listClaims } from "../db/claims"
import { findCustomerByNumber, resolveSenders, linkSenderToCustomer } from "./identity"

const EVENT = `TESTID${process.hrtime.bigint()}`
const KNOWN = `known${process.hrtime.bigint()}`
const LATER = `later${process.hrtime.bigint()}`
const NUMBER = "6281122334455"
const OTHER = "6285566778899"

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  // Stored the way a human typed it into the customer record, not normalized.
  await sql`
    INSERT INTO customers (instagram_id, whatsapp) VALUES (${KNOWN}, '0811-2233-4455')
    ON CONFLICT (instagram_id) DO UPDATE SET whatsapp = EXCLUDED.whatsapp
  `
  await sql`INSERT INTO customers (instagram_id) VALUES (${LATER}) ON CONFLICT DO NOTHING`
})

after(async () => {
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id IN (${KNOWN}, ${LATER})`
  await sql.end()
})

async function postWithSenders(senders: string[]) {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/id.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  for (const sender of senders) {
    await addClaim({
      postId, sender, customer: null, source: "ink", point: { x: 0.5, y: 0.5 },
      variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
    })
  }
  return postId
}

test("a number already on a customer record resolves however it was typed", async () => {
  assert.equal(await findCustomerByNumber(NUMBER), KNOWN)
  assert.equal(await findCustomerByNumber("0811-2233-4455"), KNOWN)
  assert.equal(await findCustomerByNumber("+62 811 2233 4455"), KNOWN)
})

test("an unknown number resolves to nobody, rather than to a new customer", async () => {
  assert.equal(await findCustomerByNumber(OTHER), null)
  const [count] = await sql`SELECT COUNT(*)::int AS n FROM customers WHERE whatsapp LIKE ${"%" + OTHER.slice(-8) + "%"}`
  assert.equal(count.n, 0, "auto-creating a phone-keyed customer would fork the namespace")
})

test("resolving a post fills in the senders it can and leaves the rest", async () => {
  const postId = await postWithSenders([NUMBER, OTHER])
  const matched = await resolveSenders(postId)
  assert.equal(matched, 1)

  const claims = await listClaims(postId)
  assert.equal(claims.find((c) => c.sender === NUMBER)?.customer, KNOWN)
  assert.equal(claims.find((c) => c.sender === OTHER)?.customer, null)
  assert.equal(claims.find((c) => c.sender === OTHER)?.state, "review", "an unknown sender needs a human")
})

test("linking a number remembers it for every future claim", async () => {
  await linkSenderToCustomer(OTHER, LATER)
  assert.equal(await findCustomerByNumber(OTHER), LATER)

  const postId = await postWithSenders([OTHER])
  assert.equal(await resolveSenders(postId), 1)
  assert.equal((await listClaims(postId))[0].customer, LATER)
})

test("linking backfills the claims that were already waiting", async () => {
  const postId = await postWithSenders([OTHER])
  await sql`UPDATE wa_claims SET customer = NULL, state = 'review' WHERE post_id = ${postId}`
  await linkSenderToCustomer(OTHER, LATER)

  const claims = await listClaims(postId)
  assert.equal(claims[0].customer, LATER, "answering once must not leave old claims stranded")
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/whatsapp/identity.test.ts`
Expected: FAIL — cannot resolve `./identity`.

- [ ] **Step 3: Implement**

Create `lib/whatsapp/identity.ts`:

```typescript
import sql from "@/lib/db-pool"
import { normalizeCustomer } from "@/lib/db/helpers"
import { normalizeNumber } from "@/lib/db/whatsapp-groups"

/**
 * Which customer a WhatsApp number belongs to, or null.
 *
 * customers.whatsapp holds whatever a human typed — "0811-2233-4455",
 * "+62 811 2233 4455", sometimes with a note after it — so the comparison
 * strips both sides to digits rather than trusting the stored spelling. Doing
 * that in SQL keeps it one query over a small table instead of pulling every
 * customer into memory to normalize.
 */
export async function findCustomerByNumber(number: string): Promise<string | null> {
  const digits = normalizeNumber(number)
  if (!digits) return null

  const [row] = await sql`
    SELECT instagram_id FROM customers
    WHERE whatsapp <> ''
      AND regexp_replace(
            CASE WHEN regexp_replace(whatsapp, '\\D', '', 'g') LIKE '0%'
                 THEN '62' || substring(regexp_replace(whatsapp, '\\D', '', 'g') from 2)
                 ELSE regexp_replace(whatsapp, '\\D', '', 'g')
            END, '\\D', '', 'g') = ${digits}
    ORDER BY id ASC
    LIMIT 1
  `
  return row ? (row.instagram_id as string) : null
}

/**
 * Fill in the customers a post's claims already imply.
 *
 * Returns how many were matched. Claims whose sender is not on file are moved to
 * review rather than left pending: they are not broken, but nobody can be
 * invoiced for them until a human says who sent them.
 *
 * Auto-creating a customer keyed by phone is deliberately not done. Orders,
 * invoices, payments and the public invoice site all key on the Instagram
 * handle, and a phone-keyed row would be a second namespace drifting beside it.
 */
export async function resolveSenders(postId: number): Promise<number> {
  const rows = await sql`
    SELECT id, sender FROM wa_claims
    WHERE post_id = ${postId} AND customer IS NULL AND state <> 'rejected'
  `

  let matched = 0
  for (const row of rows) {
    const handle = await findCustomerByNumber(row.sender as string)
    if (handle === null) {
      await sql`
        UPDATE wa_claims SET state = 'review', updated_at = NOW() WHERE id = ${row.id}
      `
      continue
    }
    await sql`
      UPDATE wa_claims SET customer = ${handle}, updated_at = NOW() WHERE id = ${row.id}
    `
    matched += 1
  }
  return matched
}

/**
 * Ask once, remember forever.
 *
 * Writes the number onto the customer record so every future claim from it
 * resolves without asking, and backfills the claims that were already waiting on
 * the answer — otherwise answering would fix the future and strand the present.
 *
 * The number is stored normalized. The spellings already in the table are left
 * alone: findCustomerByNumber copes with them, and rewriting a customer's own
 * record as a side effect of a WhatsApp reply is not this function's business.
 */
export async function linkSenderToCustomer(number: string, handle: string): Promise<void> {
  const digits = normalizeNumber(number)
  const customer = normalizeCustomer(handle)
  if (!digits || !customer) throw new Error("a number and a handle are both required")

  await sql.begin(async (tx) => {
    const [exists] = await tx`SELECT 1 FROM customers WHERE instagram_id = ${customer}`
    if (!exists) throw new Error(`no such customer: ${customer}`)

    await tx`UPDATE customers SET whatsapp = ${digits} WHERE instagram_id = ${customer}`
    await tx`
      UPDATE wa_claims
      SET customer = ${customer},
          state = CASE WHEN state = 'review' THEN 'pending' ELSE state END,
          updated_at = NOW()
      WHERE customer IS NULL AND state <> 'rejected'
        AND regexp_replace(sender, '\\D', '', 'g') = ${digits}
    `
  })
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS — everything, plus five identity tests.

- [ ] **Step 5: The claim edit route**

Create `app/api/whatsapp/claims/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"
import { normalizeCustomer } from "@/lib/db/helpers"
import { markClaimObtained } from "@/lib/db/claims"
import { linkSenderToCustomer } from "@/lib/whatsapp/identity"

type Params = { params: Promise<{ id: string }> }

const STATES = ["pending", "assigned", "review", "rejected"] as const

/**
 * Correct one claim: who sent it, how many they want, whether it counts.
 *
 * Setting a customer also writes the number onto that customer's record, so the
 * same person never has to be identified twice — that is the whole of the
 * "ask once and remember" rule, and doing it anywhere else would make it
 * optional.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  try {
    const [claim] = await sql`SELECT id, sender FROM wa_claims WHERE id = ${id}`
    if (!claim) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const body = await req.json()

    if (typeof body.customer === "string" && body.customer.trim()) {
      await linkSenderToCustomer(claim.sender as string, normalizeCustomer(body.customer))
    }

    if (body.quantity != null) {
      const quantity = Number(body.quantity)
      if (!Number.isInteger(quantity) || quantity < 1) {
        return NextResponse.json({ error: "quantity must be a whole number of 1 or more" }, { status: 400 })
      }
      await sql`UPDATE wa_claims SET quantity = ${quantity}, updated_at = NOW() WHERE id = ${id}`
    }

    // Zero is a real answer here too — "I ticked it by mistake".
    if (body.obtained != null) {
      const obtained = Number(body.obtained)
      if (!Number.isInteger(obtained) || obtained < 0) {
        return NextResponse.json({ error: "obtained must be zero or more" }, { status: 400 })
      }
      await markClaimObtained(id, obtained)
    }

    if (typeof body.state === "string") {
      if (!STATES.includes(body.state as (typeof STATES)[number])) {
        return NextResponse.json({ error: `state must be one of ${STATES.join(", ")}` }, { status: 400 })
      }
      await sql`UPDATE wa_claims SET state = ${body.state}, updated_at = NOW() WHERE id = ${id}`
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof Error && /no such customer|both required/.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error("Failed to update claim:", err)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
  }
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no output.

```bash
git add lib/whatsapp/identity.ts lib/whatsapp/identity.test.ts app/api/whatsapp/claims
git commit -m "feat(whatsapp): turn a sender's number into a customer

customers.whatsapp already exists, so most senders resolve with nobody being
asked anything. The comparison strips both sides to digits rather than trusting
the stored spelling, because that column holds whatever a human typed.

A sender nobody recognises goes to review. It is not an error and it never
creates a customer keyed by phone: orders, invoices, payments and the public
invoice site all key on the Instagram handle, and a phone-keyed row would be a
second namespace drifting beside it.

Answering once backfills the claims already waiting on that answer, so a reply
fixes the present as well as the future."
```

---

### Task 4: The shop screen

**Files:**
- Create: `app/dashboard/shop/page.tsx`
- Create: `app/dashboard/shop/ShopClient.tsx`
- Create: `app/dashboard/shop/[id]/page.tsx`
- Create: `app/dashboard/shop/[id]/ShopPostClient.tsx`
- Create: `app/api/whatsapp/shop/route.ts`

**Interfaces:**
- Consumes: `GET /api/whatsapp/posts/{id}`, `PATCH /api/whatsapp/slots/{id}`, `GET /api/whatsapp/posts/{id}/rekap`.
- Produces: `GET /api/whatsapp/shop` — the open posts an admin may count against, without exposing the owner-only post list.

Four things and no more: the photo, the SKU list, a stepper, and the panel that
says who misses out. No prices, no customers, no naming.

- [ ] **Step 1: The list route**

Create `app/api/whatsapp/shop/route.ts`:

```typescript
import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"

/**
 * Posts worth walking a shop with: the ones that still have something to buy.
 *
 * Its own route rather than a filter on /api/whatsapp/posts, which is
 * owner-only. An admin counting a shelf needs the shelves, not the archive.
 */
export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const rows = await sql`
      SELECT p.id, p.event, p.store, p.created_at,
             COUNT(s.id)::int AS sku,
             COALESCE(SUM(t.claimed), 0)::int AS claimed,
             COALESCE(SUM(t.bought), 0)::int AS bought
      FROM wa_posts p
      LEFT JOIN wa_slots s ON s.post_id = p.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(c.quantity), 0) AS claimed,
               COALESCE(SUM(c.obtained), 0) AS bought
        FROM wa_claims c WHERE c.slot_id = s.id AND c.state <> 'rejected'
      ) t ON TRUE
      JOIN events e ON e.name = p.event AND e.is_active
      GROUP BY p.id
      ORDER BY p.id DESC
      LIMIT 100
    `
    return NextResponse.json(
      {
        posts: rows.map((r) => ({
          id: r.id as number,
          event: r.event as string,
          store: (r.store as string) ?? "",
          sku: r.sku as number,
          claimed: r.claimed as number,
          bought: r.bought as number,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to list shop posts:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}
```

- [ ] **Step 2: The list page**

Create `app/dashboard/shop/page.tsx`:

```typescript
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import ShopClient from "./ShopClient"

export default function ShopPage() {
  return (
    <PageShell>
      <PageHeader
        title="Shop"
        subtitle="Count what you actually found, one shelf at a time"
      />
      <ShopClient />
    </PageShell>
  )
}
```

Create `app/dashboard/shop/ShopClient.tsx`:

```typescript
"use client"

import { useEffect, useState } from "react"
import Link from "next/link"

interface ShopPost {
  id: number
  event: string
  store: string
  sku: number
  claimed: number
  bought: number
}

export default function ShopClient() {
  const [posts, setPosts] = useState<ShopPost[] | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/whatsapp/shop", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { posts?: ShopPost[]; error?: string }) => {
        if (data.error) setError(data.error)
        else setPosts(data.posts ?? [])
      })
      .catch(() => setError("Failed to load"))
  }, [])

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!posts) return <p className="text-sm text-gray-500">Loading…</p>
  if (posts.length === 0) {
    return <p className="text-sm text-gray-500">No shelves posted for an active event yet.</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {posts.map((post) => {
        const left = post.claimed - post.bought
        return (
          <Link
            key={post.id}
            href={`/dashboard/shop/${post.id}`}
            className="flex items-center gap-3 rounded-xl border border-cream-border bg-white px-4 py-3 hover:border-brand transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground truncate">
                {post.store || "Untitled shelf"}
              </div>
              <div className="text-xs text-gray-500 tabular-nums">
                {post.event} · {post.sku} SKU
              </div>
            </div>
            <div className="text-right shrink-0">
              <div
                className={`text-sm font-bold tabular-nums ${left === 0 ? "text-green-700" : "text-red-700"}`}
              >
                {left === 0 ? "Done" : `Buy ${left}`}
              </div>
              <div className="text-xs text-gray-500 tabular-nums">
                {post.bought} of {post.claimed}
              </div>
            </div>
          </Link>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: The shelf page**

Create `app/dashboard/shop/[id]/page.tsx`:

```typescript
import PageShell from "@/components/PageShell"
import ShopPostClient from "./ShopPostClient"

export default async function ShopPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <PageShell>
      <ShopPostClient postId={Number(id)} />
    </PageShell>
  )
}
```

Create `app/dashboard/shop/[id]/ShopPostClient.tsx`:

```typescript
"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"

interface Slot {
  id: number
  size: string
  label: string
  claimed: number
  bought: number
  productId: number | null
}

interface Claim {
  id: number
  slotId: number | null
  customer: string | null
  sender: string
  quantity: number
  obtained: number
  note: string
  state: string
}

interface PostPayload {
  post: { id: number; event: string; store: string }
  slots: Slot[]
  claims: Claim[]
}

const tone = (claimed: number, bought: number) =>
  bought >= claimed ? "text-green-700" : bought > 0 ? "text-amber-600" : "text-red-700"

const dot = (claimed: number, bought: number) =>
  bought >= claimed ? "bg-green-600" : bought > 0 ? "bg-amber-500" : "bg-red-600"

export default function ShopPostClient({ postId }: { postId: number }) {
  const [data, setData] = useState<PostPayload | null>(null)
  const [error, setError] = useState("")
  const [openSlot, setOpenSlot] = useState<number | null>(null)
  // Bumped after every save so the rendered picture is refetched rather than
  // served from the browser's cache, which would show yesterday's counts.
  const [version, setVersion] = useState(0)

  const load = useCallback(() => {
    fetch(`/api/whatsapp/posts/${postId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: PostPayload & { error?: string }) => {
        if (payload.error) setError(payload.error)
        else setData(payload)
      })
      .catch(() => setError("Failed to load"))
  }, [postId])

  useEffect(load, [load])

  async function save(slotId: number, bought: number) {
    const res = await fetch(`/api/whatsapp/slots/${slotId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bought }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to save" }))
      setError(body.error ?? "Failed to save")
      return
    }
    setOpenSlot(null)
    setVersion((v) => v + 1)
    load()
  }

  async function rename(slotId: number, label: string) {
    await fetch(`/api/whatsapp/slots/${slotId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    })
    setVersion((v) => v + 1)
    load()
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>

  const claimed = data.slots.reduce((n, s) => n + s.claimed, 0)
  const bought = data.slots.reduce((n, s) => n + s.bought, 0)
  const slot = data.slots.find((s) => s.id === openSlot) ?? null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/shop" className="text-sm text-gray-500 hover:text-foreground">
          ←
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-foreground truncate">
            {data.post.store || "Untitled shelf"}
          </h1>
          <p className="text-xs text-gray-500 tabular-nums">
            {data.post.event} · {data.slots.length} SKU · {bought} of {claimed} units
          </p>
        </div>
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element -- a rendered JPEG
          from our own route; next/image would proxy it for no benefit. */}
      <img
        src={`/api/whatsapp/posts/${postId}/rekap?v=${version}`}
        alt="The shelf with a badge on each SKU showing how many are still to buy"
        className="w-full rounded-xl border border-cream-border"
      />

      <div className="flex flex-col rounded-xl border border-cream-border bg-white overflow-hidden">
        {data.slots.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setOpenSlot(s.id)}
            className="flex items-center gap-3 px-4 py-3 border-b border-cream-border last:border-b-0 text-left hover:bg-cream transition-colors"
          >
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot(s.claimed, s.bought)}`} />
            <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
              {s.label || `SKU ${s.id}`}
              {s.size ? <span className="text-gray-500 font-normal"> · {s.size}</span> : null}
            </span>
            <span className="text-xs text-gray-400 tabular-nums shrink-0">
              {s.bought}/{s.claimed}
            </span>
            <span className={`text-xs font-bold tabular-nums shrink-0 ${tone(s.claimed, s.bought)}`}>
              {s.claimed - s.bought === 0 ? "DONE" : `BUY ${s.claimed - s.bought}`}
            </span>
          </button>
        ))}
      </div>

      {slot ? (
        <SlotSheet
          slot={slot}
          claims={data.claims.filter((c) => c.slotId === slot.id && c.state !== "rejected")}
          onClose={() => setOpenSlot(null)}
          onSave={(n) => save(slot.id, n)}
          onRename={(label) => rename(slot.id, label)}
        />
      ) : null}
    </div>
  )
}

function SlotSheet({
  slot, claims, onClose, onSave, onRename,
}: {
  slot: Slot
  claims: Claim[]
  onClose: () => void
  onSave: (bought: number) => void
  onRename: (label: string) => void
}) {
  const [count, setCount] = useState(slot.bought)
  const [label, setLabel] = useState(slot.label)

  const short = slot.claimed - count

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-2xl bg-white p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto h-1 w-9 rounded-full bg-gray-300" />

        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== slot.label && onRename(label)}
          placeholder="Name it so the list reads properly"
          className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
        />
        <p className="text-xs text-gray-500 tabular-nums">
          {slot.size ? `Size ${slot.size} · ` : ""}
          {slot.claimed} claimed by {claims.length} {claims.length === 1 ? "person" : "people"}
        </p>

        {/* A stepper, not a keyboard. Claims are small numbers, and a number pad
            in a shop is where a stray 44 comes from. */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setCount((n) => Math.max(0, n - 1))}
            className="w-12 h-12 rounded-xl border border-cream-border bg-cream text-xl font-semibold"
            aria-label="One fewer"
          >
            −
          </button>
          <div className="flex-1 text-center">
            <div className="text-3xl font-bold tabular-nums leading-none">{count}</div>
            <div className="text-[10px] text-gray-500 tracking-wide">
              GOT / {slot.claimed} CLAIMED
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCount((n) => Math.min(slot.claimed, n + 1))}
            className="w-12 h-12 rounded-xl border border-cream-border bg-cream text-xl font-semibold"
            aria-label="One more"
          >
            +
          </button>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setCount(0)}
            className="flex-1 rounded-full border border-cream-border py-1.5 text-xs font-semibold text-brand bg-brand/5"
          >
            None
          </button>
          <button
            type="button"
            onClick={() => setCount(slot.claimed)}
            className="flex-1 rounded-full border border-cream-border py-1.5 text-xs font-semibold text-brand bg-brand/5"
          >
            All {slot.claimed}
          </button>
        </div>

        {short > 0 && claims.length > 0 ? <ShortPanel claims={claims} count={count} /> : null}

        <button
          type="button"
          onClick={() => onSave(count)}
          className="rounded-xl bg-brand py-2.5 text-sm font-bold text-white"
        >
          Save
        </button>
      </div>
    </div>
  )
}

/**
 * Who walks away with nothing.
 *
 * The order is not arbitrary and is not recomputed here: the server spends the
 * count across claims by paid priority, so this previews the same ordering the
 * save will apply — earliest claims first, which is the tie-break when nobody
 * has paid yet.
 */
function ShortPanel({ claims, count }: { claims: Claim[]; count: number }) {
  let remaining = count
  const rows = claims.map((claim) => {
    const gets = Math.min(claim.quantity, Math.max(0, remaining))
    remaining -= gets
    return { claim, gets }
  })

  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-cream p-2">
      {rows.map(({ claim, gets }) => (
        <div key={claim.id} className="flex items-center gap-2 text-xs">
          <span className="shrink-0">{gets >= claim.quantity ? "✅" : "❔"}</span>
          <span className="flex-1 min-w-0">
            <span className="font-semibold truncate block">
              {claim.customer ?? claim.sender}
            </span>
            {claim.note ? <span className="text-gray-500 block truncate">“{claim.note}”</span> : null}
          </span>
          <span className="text-gray-500 tabular-nums shrink-0">
            {gets} of {claim.quantity}
          </span>
        </div>
      ))}
      <p className="text-[10px] text-gray-500 leading-snug">
        Ask by replying to their message in the group — an answer there quotes the
        claim, so the bot can record it by itself.
      </p>
    </div>
  )
}
```

- [ ] **Step 4: Build and look at it**

```bash
npx tsc --noEmit
npm run build
```

Expected: both clean, with `/dashboard/shop` and `/dashboard/shop/[id]` listed.

```bash
npm run dev
```

Open `http://localhost:3000/dashboard/shop`, then the demo shelf. Check on a
narrow window that the sheet is reachable one-handed and that saving a count
re-renders the picture with a new badge.

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/shop app/api/whatsapp/shop
git commit -m "feat(shop): the screen you count on, standing in the shop

Four things and no more: the photo, the SKU list, a stepper, and the panel that
says who misses out. No prices, no customers, no Create product button — all of
that only matters at the hotel, and in a shop it sits between the owner and the
one number they came to record.

A stepper rather than a number pad, because claims are small numbers and a
keyboard on a phone in a shop is where a stray 44 comes from.

The short panel previews the same ordering the save applies rather than
inventing its own, and says how to ask: by replying in the group, so the answer
quotes the claim and the bot can record it without being told."
```

---

### Task 5: The review screen

**Files:**
- Create: `app/dashboard/wa-posts/page.tsx`
- Create: `app/dashboard/wa-posts/PostsClient.tsx`
- Create: `app/dashboard/wa-posts/[id]/page.tsx`
- Create: `app/dashboard/wa-posts/[id]/PostReviewClient.tsx`

**Interfaces:**
- Consumes: `GET /api/whatsapp/posts`, `GET /api/whatsapp/posts/{id}`, `PATCH /api/whatsapp/claims/{id}`, `POST /api/whatsapp/slots/{id}/name`, `GET /api/sheets/options` for the event list.

Everything the shop screen leaves out. Owner-only, because naming creates a
product, a price and an order for every customer behind the slot.

- [ ] **Step 1: The list page**

Create `app/dashboard/wa-posts/page.tsx`:

```typescript
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import PostsClient from "./PostsClient"

export default function WaPostsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Group Posts"
        subtitle="Shelves posted to WhatsApp, and what customers claimed on them"
      />
      <PostsClient />
    </PageShell>
  )
}
```

Create `app/dashboard/wa-posts/PostsClient.tsx`:

```typescript
"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import SearchInput from "@/components/SearchInput"
import { PaginationButton } from "@/components/Pagination"

interface Post {
  id: number
  event: string
  store: string
  note: string
  createdAt: string
}

const PAGE_SIZE = 25

export default function PostsClient() {
  const [rows, setRows] = useState<Post[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
    if (search) params.set("search", search)

    fetch(`/api/whatsapp/posts?${params}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { rows?: Post[]; totalCount?: number; error?: string }) => {
        if (data.error) setError(data.error)
        else {
          setRows(data.rows ?? [])
          setTotalCount(data.totalCount ?? 0)
        }
      })
      .catch(() => setError("Failed to load"))
      .finally(() => setLoading(false))
  }, [page, search])

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  return (
    <div className="flex flex-col gap-3">
      <SearchInput
        value={search}
        onChange={(v) => {
          setPage(1)
          setSearch(v)
        }}
        placeholder="Search store or note…"
        className="max-w-sm"
      />

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {loading ? <p className="text-sm text-gray-500">Loading…</p> : null}

      {!loading && rows.length === 0 ? (
        <p className="text-sm text-gray-500">No posts yet.</p>
      ) : null}

      <div className="flex flex-col gap-2">
        {rows.map((post) => (
          <Link
            key={post.id}
            href={`/dashboard/wa-posts/${post.id}`}
            className="flex items-center gap-3 rounded-xl border border-cream-border bg-white px-4 py-3 hover:border-brand transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground truncate">
                {post.store || "Untitled shelf"}
              </div>
              <div className="text-xs text-gray-500">{post.event}</div>
            </div>
            <div className="text-xs text-gray-400 tabular-nums shrink-0">{post.createdAt}</div>
          </Link>
        ))}
      </div>

      {totalPages > 1 ? (
        <div className="flex items-center gap-2">
          <PaginationButton onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
            Prev
          </PaginationButton>
          <span className="text-xs text-gray-500 tabular-nums">
            {page} / {totalPages}
          </span>
          <PaginationButton onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages}>
            Next
          </PaginationButton>
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: The review page**

Create `app/dashboard/wa-posts/[id]/page.tsx`:

```typescript
import PageShell from "@/components/PageShell"
import PostReviewClient from "./PostReviewClient"

export default async function WaPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <PageShell>
      <PostReviewClient postId={Number(id)} />
    </PageShell>
  )
}
```

Create `app/dashboard/wa-posts/[id]/PostReviewClient.tsx`:

```typescript
"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"

interface Slot {
  id: number
  size: string
  label: string
  claimed: number
  bought: number
  productId: number | null
}

interface Claim {
  id: number
  slotId: number | null
  customer: string | null
  sender: string
  quantity: number
  obtained: number
  note: string
  state: string
  confidence: number
}

interface Payload {
  post: { id: number; event: string; store: string; pricingMethod: string; countryId: number | null }
  slots: Slot[]
  claims: Claim[]
}

export default function PostReviewClient({ postId }: { postId: number }) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState("")
  const [version, setVersion] = useState(0)

  const load = useCallback(() => {
    fetch(`/api/whatsapp/posts/${postId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: Payload & { error?: string }) => {
        if (payload.error) setError(payload.error)
        else setData(payload)
      })
      .catch(() => setError("Failed to load"))
  }, [postId])

  useEffect(load, [load])

  function refresh() {
    setVersion((v) => v + 1)
    load()
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>

  const needsReview = data.claims.filter((c) => c.state === "review")

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/wa-posts" className="text-sm text-gray-500 hover:text-foreground">
          ←
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-foreground truncate">
            {data.post.store || "Untitled shelf"}
          </h1>
          <p className="text-xs text-gray-500">
            {data.post.event} · {data.slots.length} SKU · {data.post.pricingMethod}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start">
        {/* eslint-disable-next-line @next/next/no-img-element -- our own rendered JPEG. */}
        <img
          src={`/api/whatsapp/posts/${postId}/rekap?v=${version}`}
          alt="The shelf with a badge on each SKU"
          className="w-full rounded-xl border border-cream-border"
        />

        <div className="flex flex-col gap-4">
          {needsReview.length > 0 ? (
            <ReviewQueue claims={needsReview} onDone={refresh} />
          ) : null}

          {data.slots.map((slot) => (
            <SlotCard
              key={slot.id}
              slot={slot}
              claims={data.claims.filter((c) => c.slotId === slot.id && c.state !== "rejected")}
              onDone={refresh}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Claims that need a human before they can become anything.
 *
 * Almost always an unrecognised number. Naming refuses while one of these sits
 * under a slot, because creating the product and silently dropping that
 * person's order would be worse than stopping.
 */
function ReviewQueue({ claims, onDone }: { claims: Claim[]; onDone: () => void }) {
  const [handles, setHandles] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function link(claim: Claim) {
    const handle = (handles[claim.id] ?? "").trim()
    if (!handle) return
    setBusy(true)
    setError("")
    const res = await fetch(`/api/whatsapp/claims/${claim.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer: handle }),
    })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to link" }))
      setError(body.error ?? "Failed to link")
      return
    }
    onDone()
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">
        {claims.length} {claims.length === 1 ? "claim needs" : "claims need"} you
      </h2>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      {claims.map((claim) => (
        <div key={claim.id} className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-600 shrink-0">{claim.sender}</span>
          <input
            value={handles[claim.id] ?? ""}
            onChange={(e) => setHandles((h) => ({ ...h, [claim.id]: e.target.value }))}
            placeholder="instagram handle"
            className="flex-1 min-w-0 border border-cream-border rounded-lg px-2 py-1 text-xs bg-white"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => link(claim)}
            className="rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-40"
          >
            Link
          </button>
        </div>
      ))}
      <p className="text-[11px] text-gray-600">
        Linking writes the number onto that customer, so the same person is never
        asked twice.
      </p>
    </div>
  )
}

/** One SKU: who wants it, and the form that turns it into a product. */
function SlotCard({ slot, claims, onDone }: { slot: Slot; claims: Claim[]; onDone: () => void }) {
  const [name, setName] = useState(slot.label)
  const [valas, setValas] = useState("")
  const [gram, setGram] = useState("")
  const [price, setPrice] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const blocked = claims.some((c) => c.customer === null)

  async function create() {
    setBusy(true)
    setError("")
    const res = await fetch(`/api/whatsapp/slots/${slot.id}/name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        valas: Number(valas) || 0,
        gram: Number(gram) || 0,
        ...(price ? { price: Number(price) } : {}),
      }),
    })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to name" }))
      setError(body.error ?? "Failed to name")
      return
    }
    onDone()
  }

  return (
    <div className="rounded-xl border border-cream-border bg-white p-3 flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-foreground truncate">
          {slot.label || `SKU ${slot.id}`}
          {slot.size ? <span className="text-gray-500 font-normal"> · {slot.size}</span> : null}
        </h3>
        <span className="text-xs text-gray-500 tabular-nums ml-auto shrink-0">
          {slot.bought} of {slot.claimed} bought
        </span>
      </div>

      <div className="flex flex-col gap-1">
        {claims.map((claim) => (
          <div key={claim.id} className="flex items-center gap-2 text-xs">
            <span className="flex-1 min-w-0 truncate">
              {claim.customer ?? <span className="text-amber-700">{claim.sender}</span>}
              {claim.note ? <span className="text-gray-500"> · “{claim.note}”</span> : null}
            </span>
            <span className="text-gray-500 tabular-nums shrink-0">
              {claim.obtained}/{claim.quantity}
            </span>
          </div>
        ))}
      </div>

      {slot.productId !== null ? (
        <p className="text-xs text-green-700 font-semibold">
          Named · product #{slot.productId}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Product name"
              className="col-span-2 border border-cream-border rounded-lg px-2 py-1.5 text-sm"
            />
            <input
              value={valas}
              onChange={(e) => setValas(e.target.value)}
              inputMode="decimal"
              placeholder="Valas (price tag)"
              className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
            />
            <input
              value={gram}
              onChange={(e) => setGram(e.target.value)}
              inputMode="numeric"
              placeholder="Gram"
              className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
            />
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="numeric"
              placeholder="Price (Target Price only)"
              className="col-span-2 border border-cream-border rounded-lg px-2 py-1.5 text-sm"
            />
          </div>

          {error ? <p className="text-xs text-red-600">{error}</p> : null}
          {blocked ? (
            <p className="text-xs text-amber-700">
              One of these senders is not a customer yet. Link them above first —
              naming now would drop their order.
            </p>
          ) : null}

          <button
            type="button"
            disabled={busy || blocked || !name.trim()}
            onClick={create}
            className="rounded-lg bg-brand py-1.5 text-xs font-bold text-white disabled:opacity-40"
          >
            Create product and orders
          </button>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Build and check**

```bash
npx tsc --noEmit
npm run build
npm run dev
```

Open `http://localhost:3000/dashboard/wa-posts`, then the demo post. Confirm the
picture renders beside the SKU cards, and that a slot with an unresolved sender
refuses to name until the sender is linked.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/wa-posts
git commit -m "feat(wa-posts): the laptop screen where a slot becomes a product

Everything the shop screen leaves out: who claimed what, which senders are not
customers yet, and the form that turns a counted SKU into a product with an
order behind every claim.

The review queue is first because naming refuses while an unresolved sender sits
under a slot, and the card says so rather than letting the button fail. Linking
writes the number onto the customer, so the same person is never asked twice."
```

---

### Task 6: Settings for the bot, and the two nav entries

**Files:**
- Create: `app/dashboard/settings/WhatsAppSection.tsx`
- Modify: `app/dashboard/settings/SettingsClient.tsx`
- Create: `app/api/whatsapp/settings/route.ts`
- Modify: `components/SidebarClient.tsx`

**Interfaces:**
- Consumes: `listGroups`, `bindGroupToEvent`, `listBotAdmins`, `addBotAdmin`, `removeBotAdmin` from `lib/db/whatsapp-groups`.
- Produces: `GET/POST/DELETE /api/whatsapp/settings`.

Plan 3's worker writes `wa_groups` when the bot is invited somewhere; this is
where the owner binds a group to a trip and says whose numbers may command it.

- [ ] **Step 1: The settings route**

Create `app/api/whatsapp/settings/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import {
  listGroups, bindGroupToEvent, listBotAdmins, addBotAdmin, removeBotAdmin,
} from "@/lib/db/whatsapp-groups"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const [groups, admins] = await Promise.all([listGroups(), listBotAdmins()])
    return NextResponse.json({ groups, admins }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load WhatsApp settings:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()

    // Binding a group decides where a whole trip's claims land, so it stays with
    // the owner — the same reason /connect is not open to the admin list.
    if (typeof body.jid === "string") {
      await bindGroupToEvent(body.jid, body.event ? String(body.event) : null)
    }

    if (typeof body.number === "string" && body.number.trim()) {
      await addBotAdmin({
        number: body.number,
        label: String(body.label ?? ""),
        canConnect: Boolean(body.canConnect),
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to save WhatsApp settings:", err)
    return NextResponse.json({ error: "Failed to save" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const number = req.nextUrl.searchParams.get("number")
  if (!number) return NextResponse.json({ error: "number is required" }, { status: 400 })

  try {
    await removeBotAdmin(number)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to remove bot admin:", err)
    return NextResponse.json({ error: "Failed to remove" }, { status: 500 })
  }
}
```

- [ ] **Step 2: The settings panel**

Create `app/dashboard/settings/WhatsAppSection.tsx`:

```typescript
"use client"

import { useEffect, useState } from "react"
import EventSelect from "@/components/EventSelect"
import { PRICING_METHODS, PRICING_METHOD_LABEL, toPricingMethod } from "@/lib/pricing"
import { DEFAULT_PRODUCT_DEFAULTS, type ProductDefaults } from "@/lib/product-defaults"

interface Group {
  jid: string
  name: string
  event: string | null
}

interface Admin {
  number: string
  label: string
  canConnect: boolean
}

const inputCls =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

export default function WhatsAppSection() {
  const [groups, setGroups] = useState<Group[]>([])
  const [admins, setAdmins] = useState<Admin[]>([])
  const [events, setEvents] = useState<string[]>([])
  const [defaults, setDefaults] = useState<ProductDefaults>(DEFAULT_PRODUCT_DEFAULTS)
  const [error, setError] = useState("")

  const [number, setNumber] = useState("")
  const [label, setLabel] = useState("")
  const [canConnect, setCanConnect] = useState(false)

  function reload() {
    fetch("/api/whatsapp/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { groups?: Group[]; admins?: Admin[]; error?: string }) => {
        if (d.error) setError(d.error)
        else {
          setGroups(d.groups ?? [])
          setAdmins(d.admins ?? [])
        }
      })
      .catch(() => setError("Failed to load"))
  }

  useEffect(() => {
    reload()
    fetch("/api/sheets/options", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { events?: string[] }) => setEvents(d.events ?? []))
      .catch(() => {})
    fetch("/api/sheets/product-defaults", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { defaults?: ProductDefaults }) => d.defaults && setDefaults(d.defaults))
      .catch(() => {})
  }, [])

  async function bind(jid: string, event: string) {
    await fetch("/api/whatsapp/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jid, event: event || null }),
    })
    reload()
  }

  async function addAdmin() {
    if (!number.trim()) return
    await fetch("/api/whatsapp/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number, label, canConnect }),
    })
    setNumber("")
    setLabel("")
    setCanConnect(false)
    reload()
  }

  async function saveMethod(value: string) {
    const method = toPricingMethod(value)
    setDefaults((d) => ({ ...d, whatsappPricingMethod: method }))
    await fetch("/api/sheets/product-defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ whatsappPricingMethod: method }),
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <section className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Groups</h2>
        <p className="text-xs text-gray-500">
          Groups outlive trips. Bind one to the event whose claims it collects, and
          re-bind it next trip rather than starting a new group.
        </p>
        {groups.length === 0 ? (
          <p className="text-xs text-gray-500">
            No groups yet. Invite the bot to a group and connect it from there.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.jid} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 text-sm truncate">{group.name || group.jid}</span>
              <div className="w-56 shrink-0">
                <EventSelect
                  value={group.event ?? ""}
                  onChange={(v) => bind(group.jid, v)}
                  events={events}
                  placeholder="Not connected"
                  clearable
                  dense
                />
              </div>
            </div>
          ))
        )}
      </section>

      <section className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Who may command the bot</h2>
        <p className="text-xs text-gray-500">
          The app&apos;s own roles key on email, and a WhatsApp sender has a number
          and no login — so the bot needs its own list. Anyone here can pull the
          shopping list; only a connector may bind a group to an event.
        </p>

        {admins.map((admin) => (
          <div key={admin.number} className="flex items-center gap-2 text-sm">
            <span className="font-mono text-xs">{admin.number}</span>
            <span className="text-gray-500 flex-1 min-w-0 truncate">{admin.label}</span>
            {admin.canConnect ? (
              <span className="text-[10px] font-bold tracking-wide text-brand">CONNECTOR</span>
            ) : null}
            <button
              type="button"
              onClick={async () => {
                await fetch(`/api/whatsapp/settings?number=${encodeURIComponent(admin.number)}`, {
                  method: "DELETE",
                })
                reload()
              }}
              className="text-xs text-red-600 hover:underline"
            >
              Remove
            </button>
          </div>
        ))}

        <div className="grid grid-cols-2 gap-2">
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="08…  or  62…"
            className={inputCls}
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Whose number is it"
            className={inputCls}
          />
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={canConnect}
              onChange={(e) => setCanConnect(e.target.checked)}
            />
            May connect a group to an event
          </label>
          <button
            type="button"
            onClick={addAdmin}
            className="rounded-lg bg-brand py-2 text-sm font-semibold text-white"
          >
            Add
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Pricing for group posts</h2>
        <p className="text-xs text-gray-500">
          Which method a shelf photographed into a group starts on. Separate from the
          Add Product form&apos;s default, because the shops you photograph are
          priced differently from what you type in by hand.
        </p>
        <select
          value={defaults.whatsappPricingMethod}
          onChange={(e) => saveMethod(e.target.value)}
          className={`${inputCls} max-w-xs`}
        >
          {PRICING_METHODS.map((method) => (
            <option key={method} value={method}>
              {PRICING_METHOD_LABEL[method]}
            </option>
          ))}
        </select>
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Add the tab**

In `app/dashboard/settings/SettingsClient.tsx`, import it beside the other
sections:

```typescript
import WhatsAppSection from "./WhatsAppSection"
```

add `{ key: "whatsapp", label: "WhatsApp" }` to the `TABS` array and `"whatsapp"`
to the `Tab` union, then render it beside the other panels:

```typescript
      <div className={tab === "whatsapp" ? "" : "hidden"}>
        <WhatsAppSection />
      </div>
```

- [ ] **Step 4: The nav entries**

In `components/SidebarClient.tsx`, add to the `Procurement` section's `items`,
after Shopping List:

```typescript
      {
        href: "/dashboard/shop",
        label: "Shop",        icon: (
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
            <path d="M3 6h18" />
            <path d="M16 10a4 4 0 0 1-8 0" />
          </svg>
        ),
      },
      {
        href: "/dashboard/wa-posts",
        label: "Group Posts",        icon: (
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        ),
      },
```

`canAccessRoute` already filters these: `/dashboard/shop` is in `ADMIN_ROUTES`,
`/dashboard/wa-posts` is not, so an admin sees one and the owner sees both.

`components/MobileNavClient.tsx` needs no change. Its bottom bar is a curated
four — Products, Order, Payments, Shopping List — and everything else reaches
mobile through the drawer, which renders `SidebarClient`. Adding a fifth tab
would crowd the bar to buy nothing.

- [ ] **Step 5: Build and check both roles**

```bash
npx tsc --noEmit
npm run build
npm run dev
```

Expected: `/dashboard/settings` shows a WhatsApp tab; the sidebar shows Shop and
Group Posts. Confirm an admin session sees Shop but not Group Posts.

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/settings app/api/whatsapp/settings components/SidebarClient.tsx
git commit -m "feat(settings): bind groups, list the bot's admins, price group posts

Groups outlive trips, so the screen binds one to an event and expects it to be
re-bound next trip rather than replaced.

The admin list exists because the app's roles key on email and a WhatsApp sender
has a number and no login. Anyone listed may pull the shopping list; the
connector flag marks whoever may bind a group to an event, which decides where a
whole trip's claims land.

Shop and Group Posts appear in the sidebar under Procurement, and the existing
route-access list does the filtering: counting is open to admins, naming is not."
```

---

## What this plan does not build

- **Anything WhatsApp.** No Baileys, no `/mulai`, no `/rekap`, no reaction
  reading — plan 3. Every table and route those need now exists.
- **Dragging a slot's position.** The renderer draws one badge where two SKU
  share a point, which is right when both hang on one peg and wrong when the
  cluster radius merged two pegs. Splitting a slot by hand is the fix, and it
  wants a considered interaction rather than a corner of this plan.
- **Recording a purchase against orders after naming.** Naming now writes
  `unit_buy` from what each claim obtained, so the existing purchasing route is
  only needed for quantities bought *after* a slot was named — which is the
  ordinary Shopping List flow already in the app.
