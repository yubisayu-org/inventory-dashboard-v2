# Fulfillment Gaps: Out-of-Stock Per-Order Choice + List Order Guardrails + Order History

## Context

Fulfillment already flows through the right pages (Shopping List buys with paid-first+FIFO allocation, Arrival List receives with wrong/broken/missing/cancelled modes, Ship page ships). But the user still falls back to raw `Buy`/`Arrive` cell edits on List Order in two situations, and those edits (`updateOrderOwnerCell`, lib/db/orders.ts:351-370) are bare single-column UPDATEs — no caps, no receipt, no excess banking.

User decisions: (1) out-of-stock at the store needs a **per-case choice** of which orders to cancel vs keep open; (2) arrival-side wrong/broken flow is fine as-is — no changes; (3) keep List Order raw edits but **guardrail** them; (4) auditability is the underlying concern — add an **in-app per-order change history** reading the existing audit log (raw edits are already captured by the `orders` audit trigger, 029_audit_log.sql — the gap is visibility, not capture); (5) no mandatory reason on edits — optional receipt only.

Key discoveries that shape the design:
- An out-of-stock flow already exists: BuyModal "Out of stock" tab (ShoppingListClient.tsx:836-1097, `mode==="oos"`) → `action:"out_of_stock"` (app/api/sheets/shopping-list/route.ts:33-40) → `markProductOutOfStock` (lib/db/shopping-list.ts:328-379), which cancels a *quantity* using reverse-priority FIFO. The only gap is per-order checkboxes instead of qty auto-pick.
- **Refunds must NOT be created explicitly.** Cancellation flows (cancelOrderLines, recordBrokenArrival etc.) never insert refunds; `materializeOverpaymentRefunds` (lib/db/finance.ts:693-799) auto-creates `reason='overpayment'` rows, and its dedupe guard (verified :791-793) only checks `reason='overpayment'` — an explicit `reason='unavailable'` refund would double-refund. Rely on the materializer; the modal copy says "auto-detected as overpayment".
- The parked inventory-ledger rework (docs/plans/inventory-ledger-rework.md) is unaffected: nothing here writes to `excess_purchase` (out-of-stock = nothing received; guardrails block overbuy rather than banking it).

No DB migration needed.

## Part A — Shopping List out-of-stock: per-order choice

### A1. `lib/db/shopping-list.ts` — replace `markProductOutOfStock` (:328-379) with:

```ts
export async function markOrdersOutOfStock(
  data: { event: string; productId: number; orderIds: number[] },
  db: DBExecutor = sql,
): Promise<{ cancelledOrderIds: number[]; cancelledUnits: number }>
```

- Takes `db: DBExecutor` (like `cancelOrderLines`) so the route runs it under `withActor` and it's rollback-testable.
- One atomic UPDATE: subselect the given ids `WHERE event/product match AND unit > COALESCE(unit_buy,0) FOR UPDATE`, set `unit = COALESCE(unit_buy,0)` (cancel only the unbought remainder; bought part stays; rows kept for history — fully-unbought orders end at unit=0 and drop off shopping list and invoice). RETURNING gives cancelledUnits — server recomputes pending, never trusts client qty.
- Doc comment: refunds auto-materialize as overpayment; nothing logged to inventory (nothing was received).

Also: add `'unitPrice', o.unit_price` to both JSON_BUILD_OBJECT aggregations in `getShoppingList` (:79-85, :113-119) and `unitPrice: number` to `ShoppingListOrder` (:29-38) — modal shows Rp impact.

### A2. `app/api/sheets/shopping-list/route.ts` (:33-40)

`out_of_stock` branch: body `{ action, event, productId, orderIds }`; validate orderIds non-empty positive ints; `withActor(email, (tx) => markOrdersOutOfStock(..., tx))`. Drop `quantityOutOfStock` (only client is BuyModal, updated in same change — typecheck confirms).

### A3. `app/dashboard/shopping-list/ShoppingListClient.tsx` — BuyModal OOS tab

- Replace qty input + reversed-FIFO preview (:858, :1024-1072) with a checkbox list, **default all checked**: per pending order — checkbox · paid dot (reuse PAID_DOT/PAID_LABEL) · customer (displayIg) · pending qty · existing `OOS_OUTCOME[paidStatus]` hint · `fmt(pending * unitPrice)`.
- Footer summary: "Cancels N unbought unit(s) across M order(s) · invoice reduction ≈ Rp X · paid customers' refunds appear on the Refunds page (auto-detected as overpayment)".
- Submit disabled when none selected; POST `{ action:"out_of_stock", event, productId, orderIds }`; on success `onSuccess()` (existing refetch :298-300).
- "Keep open" = closing the modal; add hint line "Not cancelling? Just close — the item stays on the list."
- Partial-stock case goes in the hint too: "Store had some stock? Mark those bought first, then cancel the rest."
- Remove the now-unused `isOos` reversed-`computeFill` path (computeFill stays for buy tab).

## Part B — List Order guardrails (raw edits stay, made safe)

### B1. `lib/db/orders.ts` — `updateOrderOwnerCell` (:351-370) gains validation + optional receipt

```ts
updateOrderOwnerCell(rowNumber, column: "unit_buy"|"unit_arrive", value: number|null, receipt?: string, db: DBExecutor = sql)
```

1. `SELECT unit, unit_buy, unit_arrive, unit_ship, unit_hold, receipt ... FOR UPDATE`; throw if missing.
2. Reject non-integer / negative values.
3. `unit_buy`: throw if `v > unit` ("overbought stock belongs in Inventory — use the Shopping List buy flow") or `v < unit_arrive` ("lower Arrive first"). When raising and `receipt?.trim()`, append using the shopping-list pattern (shopping-list.ts:418-420: `old ? old + ", " + r : r`).
4. `unit_arrive`: throw if `> COALESCE(unit_buy,0)` or `< (unit_ship??0)+(unit_hold??0)` (protects Ship-page invariant).

### B2. `app/api/sheets/duplicate-form/[row]/route.ts` (:49-64)

`owner_cell` branch: pass optional `body.receipt`; try/catch → 400 with `e.message` (copy the return_excess pattern at :90-99).

### B3. `app/dashboard/list-order/DataTable.tsx` — inline cells

- `handleCellSave` (:151-170) accepts optional receipt, includes in PUT body. EditableNumberCell error display already handles thrown errors (:595-623).
- Buy/Arrive column defs (:248-277): client pre-check same bounds as server; violations set the cell's error state locally, no request.
- New `OwnerBuyDialog` (styled like price-confirm dialog :904-928), triggered from Buy cell commit:
  - **Lowering**: "This loses track of N bought unit(s) — Return to Inventory banks them instead." Buttons: Use Return to Inventory (opens EditOrderModal, which contains ReturnToExcessControl :875-877) / Lower anyway / Cancel.
  - **Raising**: optional receipt input ("appended to the order's receipt"), Save; empty fine.

### B4. `DataTable.tsx` — EditOrderModal (:697-931)

- Validate buy/arrive drafts against `Number(form.unit)` before the owner_cell PUT loop (:770-786); violations → inline `setError`, abort.
- Optional Receipt input in the owner correction block (:861-879), shown only when buy draft > current; sent with the unit_buy PUT.
- Buy draft lower than current → amber hint + confirm dialog (reuse confirmPriceOpen pattern :718) with Lower anyway / use Return control choice.

## Part C — Per-order change history (in-app audit view)

Audit capture already exists: every INSERT/UPDATE/DELETE on `orders` lands in `audit.audit_log (table_name, row_id TEXT, action, old_row JSONB, new_row JSONB, actor, at)` with index `idx_audit_log_table_row (table_name, row_id)`; `app_runtime` has SELECT (029_audit_log.sql). This part only surfaces it.

### C1. `lib/db/orders.ts` — new reader

```ts
export interface OrderAuditEntry { action: string; actor: string | null; at: string; changes: { field: string; from: string | null; to: string | null }[] }
export async function getOrderAuditHistory(orderId: number): Promise<OrderAuditEntry[]>
```

- `SELECT action, old_row, new_row, actor, at FROM audit.audit_log WHERE table_name = 'orders' AND row_id = ${String(orderId)} ORDER BY at DESC LIMIT 50`.
- Diff old_row/new_row in TS over a whitelist of meaningful fields: `unit, unit_buy, unit_arrive, unit_ship, unit_hold, unit_price, receipt, note, event, customer, product_id` — emit only changed ones (INSERT → all non-null as from:null; DELETE → all as to:null).

### C2. Route — `app/api/sheets/duplicate-form/[row]/history/route.ts`

GET, session-gated like the sibling route (any authenticated role — read-only), returns `{ history: OrderAuditEntry[] }`.

### C3. UI — EditOrderModal "History" section (DataTable.tsx)

- Collapsible "History" section at the bottom of EditOrderModal; lazy-fetch on first expand (drawer/expanded-row lazy pattern already used elsewhere, e.g. ExpandedInvoice in PaymentStatusPanel.tsx).
- Each entry: relative/short date · actor (email local-part; "system" when null) · change list "Buy: 2 → 5", "Note: … → …". Field labels mapped to the UI names (Buy/Arrive/Ship/Hold/Qty/Price/Receipt/Note).
- Because the trigger captures writes from EVERY page, this shows shopping-list buys, arrival receipts, ship increments, and raw cell edits in one place — the actual audit answer.

## Sequencing

1. Part A as one unit (A1→A2→A3 — typecheck breaks between are expected).
2. Part B: B1→B2 (server-safe alone; stale clients get clear 400s), then B3→B4.
3. Part C independent of both (pure read path); any order.

## Verification

- `npx tsc --noEmit -p .` clean (also proves no leftover `markProductOutOfStock`/`quantityOutOfStock` refs).
- Ad-hoc rollback test (npx tsx script in project dir, deleted after): inside `sql.begin` — `markOrdersOutOfStock` on a real pending order → assert `unit === unit_buy` + cancelledUnits; `updateOrderOwnerCell(id,"unit_buy",999,...)` → expect throw; then throw to ROLLBACK.
- Manual: OOS tab shows checked list with paid dots + Rp impact; unchecking spares an order; partially-bought order keeps bought units; paid customer surfaces on Refunds page as overpayment; closing modal changes nothing. List Order: Buy > unit rejected inline; lowering pops the dialog and Return-to-Inventory path works; receipt appends not overwrites; Arrive capped by Buy; admin (non-owner) cells stay read-only. History section: shows a shopping-list buy (actor + unit_buy change), a raw cell edit, and a note edit for the same order; entries ordered newest-first. Regression: normal buy flow, bulk PurchaseModal, return_excess, arrival special modes untouched.

## Risks

- **Refund label is 'overpayment', not 'unavailable'** — by design (double-refund otherwise). If the label matters later, the materializer's guards must learn about 'unavailable' rows first (finance-critical; deferred).
- **Whole-remainder cancels only**: old qty-mode could cancel part of one order's pending; workaround (buy first, then OOS) documented in modal hint.
- **Historic rows with unit_buy > unit**: owner-cell edits on them now 400 until brought into range; message points at the right fix. Bulk stages "2"/"3" remain uncapped (no UI callers; unchanged).
- **EditOrderModal partial save** (stage 1 ok, capped correction 400s): existing behavior, now with a clearer message.
- **History completeness**: audit_log only spans back to when migration 029 was applied, and `actor` is NULL for writes outside `withActor` (public registration endpoint, direct SQL) — shown as "system". Not a defect, but worth knowing when reading old orders' history.

## Deferred follow-up (decided, separate plan)

**Receipts → purchase batches.** User confirmed direction: replace the concatenated `orders.receipt` text with `purchases` (receipt no, date, note) + `purchase_allocations (purchase_id, order_id, qty)` tables; buy flow writes 1 purchase + N allocations instead of string-appending; historic strings migrated by separator split with qty NULL. Deliberately NOT in this plan — but Part B's optional-receipt param (`updateOrderOwnerCell`) and the shopping-list receipt-append pattern are the two spots that plan will rework, so keep them thin.
