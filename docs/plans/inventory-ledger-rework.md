# Inventory Restructure: Global Product Pool + Movement Ledger

## Context

The Inventory page (`/dashboard/excess-purchase`) is backed by one mutate-in-place table, `excess_purchase`, with three structural flaws: stock is locked to the event it came from (physical stock isn't event-bound — user edits a row's event as a retargeting workaround), items are matched by exact free-text name even though `orders` has `product_id`, and applying stock mutates/deletes rows so there is no history of where stock came from or went.

User-approved redesign (all three recommended options accepted):
1. **Global pool per product** — stock keyed by `product_id`, consumable by orders in any event; event becomes provenance metadata.
2. **Full movement ledger** — every stock-in and stock-out is an immutable row; on-hand = SUM.
3. **Aggregate display** — one row per product (sellable/broken split), expandable to movement history.

Verified facts: `products` has `UNIQUE (name, store)` — name alone NOT unique (000_init.sql:60). `019_app_runtime_role.sql:36-39` `ALTER DEFAULT PRIVILEGES` gives new tables full DML to `app_runtime` automatically (so the ledger needs an explicit REVOKE to be append-only). Next migration number on development = **038** (max is 037). ⚠️ The parked refunds feature branch also reserves 038 for `live_balances_view` — whichever merges second must renumber. `supabase/schema.sql` is a maintained mirror — update alongside. Arrival-list items already expose `productId` (lib/db/fulfillment.ts:54); `markProductBought` already receives `productId` (lib/db/shopping-list.ts:383). Migrations are applied manually by the user in the Supabase SQL editor as postgres.

## Step 1 — Migration `supabase/migrations/038_inventory_movements.sql`

Pre-flight query (user runs first, separately):
```sql
SELECT e.items, COUNT(*) AS rows, SUM(e.unit_buy) AS units,
       (SELECT COUNT(*) FROM products p WHERE p.name = e.items) AS product_matches
FROM excess_purchase e
GROUP BY e.items
HAVING (SELECT COUNT(*) FROM products p WHERE p.name = e.items) <> 1;
```

Migration (single BEGIN/COMMIT):
```sql
CREATE TABLE inventory_movements (
  id          SERIAL PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty         INTEGER NOT NULL CHECK (qty <> 0),          -- signed: >0 in, <0 out
  condition   TEXT NOT NULL DEFAULT 'sellable' CHECK (condition IN ('sellable','broken')),
  reason      TEXT NOT NULL CHECK (
    (qty > 0 AND reason IN ('overbuy','overship','wrong_product','broken',
                            'customer_cancelled','manual','adjustment'))
    OR (qty < 0 AND reason IN ('applied','disposed','manual_out','adjustment'))
  ),
  event       TEXT REFERENCES events(name) ON UPDATE CASCADE ON DELETE SET NULL,
  order_id    INTEGER REFERENCES orders(id) ON DELETE SET NULL,   -- set on 'applied'
  receipt     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',                    -- absorbs expected_item as "expected: X"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_inv_mov_product ON inventory_movements (product_id, condition);
CREATE INDEX idx_inv_mov_created ON inventory_movements (created_at DESC);

CREATE VIEW inventory_on_hand AS
SELECT product_id, condition, SUM(qty)::int AS on_hand, MAX(created_at) AS last_movement_at
FROM inventory_movements GROUP BY product_id, condition;
```
Then, in the same script:
- DO block: RAISE EXCEPTION listing any `excess_purchase.items` with zero product-name match (loud abort; user fixes names/catalog and re-runs).
- Copy every excess row into the ledger as opening stock-ins preserving reason/event/receipt/created_at; `condition = 'broken'` when reason='broken'; ambiguous names (2+ stores) resolved by LATERAL pick: prefer product having orders in that row's event, else lowest id.
- Self-check DO block: old row count + SUM(unit_buy) must equal new count + SUM(qty), else RAISE EXCEPTION (aborts before drop).
- `DROP TABLE excess_purchase;`
- Audit trigger on `inventory_movements` (029 pattern).
- `REVOKE UPDATE, DELETE ON inventory_movements FROM app_runtime;` (append-only — corrections are new movements).

Update `supabase/schema.sql`: replace excess_purchase block (~:123), swap `'excess_purchase'` → `'inventory_movements'` in audit allowlist (~:281), add REVOKE.

## Step 2 — `lib/db/inventory.ts` (new) + types

`lib/db/types.ts`: remove `ExcessRow`/`ExcessReason`; add `StockCondition`, `StockInReason`, `StockOutReason`, `InventoryItem { productId, productName, store, sellable, broken, lastMovementAt }`, `InventoryMovement { id, qty, condition, reason, event, orderId, receipt, note, createdAt }` (+ customer display name for applied rows).

Functions (export from lib/db.ts):
- `recordStockIn(entries: StockInEntry[], db = sql)` — bulk INSERT; condition defaults 'broken' when reason==='broken'.
- `recordStockOut({ productId, qty, reason, condition, orderId?, note?, event? }, db)` — `pg_advisory_xact_lock(hashtext('inv:'||product_id))`, SUM-check on-hand ≥ qty, INSERT negative row; throw on insufficient stock.
- `getInventorySummary(): InventoryItem[]` — products JOIN view, pivot sellable/broken, HAVING either <> 0.
- `getProductMovements(productId)` — ORDER BY id DESC, LEFT JOIN orders for customer on 'applied'.
- `resolveProductIdsByName(names, db)` — helper for producers that only have a name (min-id tie-break, throw on miss).
- `applyInventoryToOrders({ productId?, receipt }, db)` — one transaction: advisory lock per product; read sellable on-hand; eligible orders = `product_id = ANY(...) AND COALESCE(unit_buy,0) < unit` **any event**; sort paid → partial → unpaid then id ASC using `fetchPaidStatusMap(null)` (add cross-event variant `compareOrderPriorityAnyEvent` next to `compareOrderPriority` in lib/db/shopping-list.ts); `allocateFifo` (lib/fifo-fill.ts); `bulkUpdatePurchase` (lib/db/orders.ts:500) with existing receipt-chaining; one negative `applied` movement per filled order (order_id, order's event, allocated qty). Returns `ApplyProductResult[] { productId, productName, available, filled[], remainder }`.

## Step 3 — Producer call-site changes (complete list)

Replace every `appendExcessPurchase`/direct-INSERT with `recordStockIn`:
1. `lib/db/shopping-list.ts:428-433` (markProductBought) — has productId already; reason `overbuy`.
2. `app/api/sheets/purchasing/route.ts:105-122` — productId from event FormRows (`r.productId` matching item name) else `resolveProductIdsByName`; reason `overbuy`.
3. `app/api/sheets/arrive/route.ts:110-162` — overship (reason `overship`) + wrong-product (reason `wrong_product`, note `expected: X`, productId of *received* item).
4. `lib/db/orders.ts:677-703` `recordWrongProduct` — signature gains `receivedProductId`; caller `app/api/sheets/arrival-list/route.ts:51` + ArrivalListClient wrong-mode payload (SearchableSelect options already carry ids).
5. `lib/db/orders.ts:712-736` `recordBrokenArrival` — gains `productId` (arrival items expose it); reason `broken`.
6. `lib/db/orders.ts:765-793` `recordCustomerCancellation` — gains `productId`; reason `customer_cancelled`. Caller arrival-list/route.ts:113 + client payload.
7. `lib/db/orders.ts:807-846` `cancelOrderUnits` — add `product_id` to FOR UPDATE SELECT, drop trust-the-client productName; caller app/api/sheets/orders/route.ts:75 (CancelOrderFromInvoiceModal stops sending productName).
8. `lib/db/orders.ts:428-496` `returnOrderUnitsToExcess` — add `o.product_id` to SELECT; replace INSERT at :469-473; reason `overbuy`, note `returned from order #<id>`.

Delete from lib/db/orders.ts: `getExcessPurchaseRows`, `mapExcessRow`, `getExcessPurchasePaginated`, `PaginatedExcess`, `EXCESS_TOTAL_COUNT_UNCHANGED`, `appendExcessPurchase`, `updateExcessRowUnitBuy`, `updateExcessRow`, `deleteExcessRow`. (Dropping `appendExcessPurchase` makes typecheck enforce completeness.)

## Step 4 — API routes

New `app/api/sheets/inventory/`:
- `route.ts` — GET `{ items: InventoryItem[] }` (no pagination — tens of rows); PUT manual stock-in `{ productId, qty≥1, condition?, event?, note }` reason `manual` (owner-only, withActor).
- `apply/route.ts` — POST `{ productId?, receipt }` → `{ results: ApplyProductResult[] }`; productId absent = Apply All; **one** withActor transaction (current bulk runs 3+).
- `adjust/route.ts` — POST `{ productId, condition, qty≥1, kind: "dispose"|"remove"|"adjust", direction?, note }` → reasons `disposed`/`manual_out`/`adjustment`; validated by recordStockOut. This replaces edit-qty/delete-row — corrective movements, never mutation.
- `[productId]/movements/route.ts` — GET movements for expanded row (lazy).

Delete `app/api/sheets/excess-purchase/route.ts` and `.../[row]/route.ts`.

## Step 5 — UI

- `git mv app/dashboard/excess-purchase app/dashboard/inventory`; update `components/SidebarClient.tsx:175` href (check MobileNavClient + lib/access.ts too, per the list-order rename precedent).
- New `InventoryTable.tsx` replacing ExcessTable.tsx:
  - Client-side DataGrid (drop serverSide/usePaginatedFetch). Columns: Product (name + store subtext), Sellable (bold tabular), Broken (red badge when > 0), Last movement, Actions.
  - `renderExpandedRow` → `<MovementHistory>` with lazy fetch + cache, following ExpandedInvoice pattern (app/dashboard/invoice/PaymentStatusPanel.tsx). Rows: reason badge (reuse REASON_LABEL/CLASS + out-reasons), signed qty (green +/red −), event, customer for applied, note/receipt, date.
  - Row actions: **Apply** (receipt prompt → POST apply {productId}; reuse ApplyResultBanner), **Adjust** (add/remove qty + note), **Dispose** (only when broken > 0).
  - Toolbar: total sellable badge, **Add Inventory** (SearchableSelect keyed by product **id**, not name — same-name/different-store stay distinct; event optional), **Apply All**.
  - `renderMobileCard` mirroring desktop.
- Copy touch-ups: ArrivalListClient payloads (step 3), CancelOrderFromInvoiceModal body; grep for other "excess" copy.

## Sequencing

1. Migration file + schema.sql (inert until run).
2. types + lib/db/inventory.ts + lib/db.ts export.
3. Producers + routes + UI + deletions in one atomic change (typecheck-enforced).
4. User: pre-flight SELECT → fix unmatched names → run 038 in SQL editor → deploy immediately (old code writes to a dropped table otherwise; producers are owner-only so the window is low-risk).

## Verification

- `npx tsc --noEmit -p .` and `npm run build`.
- Ad-hoc rollback test (scripts/*.ts pattern, `node --env-file=.env.local --import=tsx`, run from project dir): inside one transaction — stock-in → assert on-hand delta; oversized stock-out → expect throw; `applyInventoryToOrders` on a product with pending orders → assert unit_buy bumps + applied movements sum; then throw to ROLLBACK. Separately assert `UPDATE inventory_movements` as app_runtime fails (append-only).
- Migration self-checks counts before DROP (built in).
- Manual UI: aggregate rows match pre-migration sums; expanded history shows migrated provenance; Apply fills paid-first across events; overbuy/overship/wrong/broken/cancel each produce a visible movement; audit_log rows appear.

## Risks

- **Unmatched names at migration**: loud abort by design; fix via existing UI before cutover. Ambiguous names resolved deterministically (event-orders-first, else min id) — keep the pre-flight output.
- **Deploy window**: migrate-then-deploy within minutes; old build 500s on producer writes after DROP.
- **Global pool can fill stale events' orders**: mitigated by paid-first priority + per-product result banner; event-activity filter is a one-line WHERE later if needed.
- **038 number clash** with parked refunds branch — renumber whichever lands second.
