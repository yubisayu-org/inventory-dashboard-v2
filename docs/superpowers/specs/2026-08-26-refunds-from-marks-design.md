# Refunds From Marks — Design

**Date:** 2026-08-26
**Branch:** not started
**Status:** approved in brainstorming, not yet planned

## Goal

A refund should exist because somebody recorded a reason, not because
arithmetic noticed a gap.

Today the Refunds pending tab is filled almost entirely by
`materializeOverpaymentRefunds` — 224 of 232 live refunds. It compares what a
customer paid against what they are invoiced and, where paid is larger, writes
a row reasoned `overpayment` with the note *"Auto-detected: paid Rp X of Rp Y"*.
The row is correct about the money and silent about the cause, and the customer
is told nothing.

The causes are already recorded elsewhere. The Shopping List marks an item sold
out; the Receiving List marks a parcel's contents missing, broken or wrong.
Those marks reduce the order and stop. This design makes them create the refund
and tell the customer, with the reason they already know.

## What the audit log says

Of the 224 live overpayment refunds, split by whether that customer's order
units ever shrank on that trip (`audit.audit_log`, `orders` UPDATE where the
new `unit` is lower than the old):

| | refunds | value |
|---|---:|---:|
| units were reduced — a mark would have covered it | 94 | Rp 43,311,000 |
| no reduction — a true overpayment | 130 | Rp 5,675,100 |

Two things follow, and they decide the shape of everything below.

**The detector cannot be retired.** 130 refunds have no order reduction behind
them. Nobody marked anything; the customer simply transferred too much. No mark
will ever fire for them, and removing the detector would stop the system
mentioning money it owes.

**The detector should not be the main producer.** The reduction-driven refunds
carry most of the value, and every one of them had a knowable cause at the
moment it happened — a cause the refund does not record and the customer never
hears.

So the detector stays, behind the marks, catching only what no mark can see.

## Model

### Marks create refunds

| mark | today | reason |
|---|---|---|
| Shopping List → sold out (`markProductOutOfStock`) | reduces `unit`, logs `excess_purchase` | `unavailable` |
| Receiving List → missing (`recordNotReceived` mode `missing`) | reduces, logs `missing` | `shipping_loss` |
| Receiving List → broken (mode `broken`) | reduces, logs `broken` | `damaged` |
| Receiving List → wrong (mode `wrong`) | reduces, logs `wrong_product` | **`wrong_item`** (new) |
| Receiving List → cancelled (mode `cancelled`) | reduces, logs `customer_cancelled` | **no refund** |

`wrong_item` is a new entry in `REFUND_REASONS`, deliberately not folded into
`other`: a wrong delivery is a distinct thing that happened and the pending tab
should say so.

`cancelled` creates no refund here. The customer asked to cancel; that path
already exists on the Arrival List and the invoice line and is not what this
design is about.

> **Parked, decided later.** Whether the `cancelled` mode should leave the
> Receiving List altogether is a separate question, deliberately not settled
> here. This spec assumes it stays and simply produces no refund, so nothing
> below depends on the answer either way.

### A reduction only owes a refund if it was paid for

This is the rule most likely to be got wrong, and the reason a mark cannot
simply refund the value of what it removed.

Reducing an unpaid order lowers what the customer owes. Nothing is owed back.
Creating a refund there invents a debt.

So each mark computes, per affected customer:

```
owed = min(value of the units removed, max(0, total_paid − invoice_total_after))
```

`invoice_total_after` is the live figure the rest of the app already uses:
`subtotal + ongkir × CEIL(gram/1000) + adjustments`, evaluated after the
reduction. `owed = 0` creates nothing.

The To-check list arrives at the same number by a different route, so a mark's
refund and the uncovered figure can never disagree about what is owed.

### Partial marks

A mark can remove some of a customer's units and leave the rest. The refund is
for the units actually removed, capped by what that customer has overpaid.
Several customers are usually affected by one mark; each gets their own refund
and their own notice, or neither.

### Undoing a mark cancels its refund

An undone mark sets its refund to `cancelled` rather than deleting it, matching
how the detector already retires rows it no longer believes in — history is
kept and the pending tab is not haunted.

A refund with a linked payment is never auto-cancelled. That guard exists today
in the detector (`NOT EXISTS (SELECT 1 FROM payments WHERE refund_id = r.id)`)
for exactly this reason: once money has moved against a refund it belongs to a
person, not a process.

### The notice goes with the refund, automatically

Each mark-created refund is accompanied by a customer notice, sent in the same
transaction, through `sendInvoiceNotice` in `lib/db/notices.ts`. That path
already does this and says why:

> *The notice and whatever it announces are one action. A refund notice that
> does not create the refund promises money the system has no record of.*

The wording lives in `notice_templates` (migration 114), so it is the owner's to
change without a deploy. One template per reason.

### The detector stops creating refunds

`materializeOverpaymentRefunds` no longer inserts. Nothing writes a refund
without a person or a mark deciding to.

Its other two passes stay, because rows already exist and will keep existing:

- **reconcile** keeps a live `overpayment` row equal to what is still uncovered
- **cancel** retires one whose overpayment has resolved

Both stay scoped to `reason = 'overpayment'` and to pristine rows — no linked
payment — so a mark's refund is never rewritten or retired by them.

The residual both passes work from now accounts for every live refund on that
pair, not only overpayment ones, or a mark's refund and an older auto-created
row would each claim the same money:

```
residual_for(row r) = (total_paid − invoice_total)
                    − SUM(refund_amount of live refunds WHERE id <> r.id)
```

### Overpayments to check

What the detector used to insert becomes a list you review. A second tab beside
Pending, named **To check**, listing every `(event, customer)` where money is
uncovered:

```
uncovered = (total_paid − invoice_total)
          − SUM(refund_amount of live refunds on that pair)
```

Rows are observations, not debts the system has committed to. Each shows the
customer and trip, what they paid, what they were invoiced, the uncovered
amount, and a **Create refund** action that writes an ordinary `overpayment`
refund for exactly that figure — landing it in Pending.

Ordered largest first, because that is the order they get worked.

**Small amounts collapse.** Rows under a threshold (Rp 10.000, a constant, not a
setting until there is a reason for one) fold into a single expandable line
carrying their count and total. They are one click from being refunded and are
never hidden — but twenty-three shipping-rounding differences cannot bury the
three that matter.

Paid and invoiced sit beside the gap so a Rp 2.000 difference can be recognised
as rounding without opening the invoice.

**Why this is not Pending.** Pending is a to-do list: every row is money you have
decided to send, which is what makes it worth reading carefully. A rounding
difference is not a task. Putting it in Pending teaches you to skim the one list
that must not be skimmed.

### The Dashboard counts what is uncovered

`overpayment_candidates` becomes the count of that same list, so the tile and
the tab always agree:

```diff
-  AND NOT EXISTS (
-    SELECT 1 FROM refunds r
-    WHERE r.event = oa.event AND r.customer = oa.customer
-      AND r.reason = 'overpayment' AND r.status != 'cancelled'
-  )
+  AND (paid − invoice_total) > COALESCE((
+        SELECT SUM(r.refund_amount) FROM refunds r
+         WHERE r.event = oa.event AND r.customer = oa.customer
+           AND r.status <> 'cancelled'
+      ), 0)
```

Its label changes from *"overpayments to refund"* to *"overpayments to check"* —
it now links to a list of things to look at, not money already committed.

### A refund says when the same customer owes elsewhere

Refunds are per trip. A customer can be owed on one and outstanding on another,
and nothing on the row says so — you have to know. Marks now create refunds
without being asked, so that knowledge is less likely to be in anyone's head.

Each pending refund row shows any outstanding balance that customer carries on
other trips, with the credit action pre-filled:

> **Outstanding elsewhere · Rp 300.000 on POCN202607.**
> [ Apply Rp 200.000 to POCN202607 ]  [ Refund as cash ]

The mechanism exists — `applyRefundAsCredit(refundId, targetEvent, amount)`
writes a `payments` row with `kind='credit'` and `refund_id` set, and moves the
refund to `applied_to_next_order`. That linked payment is also what makes every
automatic pass leave the row alone from then on. Only the prompt is new.

The balance comes from the same per-invoice figures the Invoice page already
computes; the row lists other trips where that customer's outstanding is above
zero, largest first.

## Files

| file | change |
|---|---|
| `lib/db/types.ts` | add `wrong_item` to `REFUND_REASONS` |
| `lib/db/refund-owed.ts` *(new)* | the `owed` calculation, pure and tested |
| `lib/db/shopping-list.ts` | `markProductOutOfStock` creates refunds + notices |
| `lib/db/fulfillment.ts` | `recordNotReceived` does the same for missing/broken/wrong |
| `lib/db/finance.ts` | drop the insert; reconcile and cancel work from the residual |
| `lib/db/refund-residual.ts` *(new)* | uncovered/residual arithmetic, pure and tested |
| `lib/db/overpayments.ts` *(new)* | the To-check list, and creating a refund from a row |
| `lib/db/dashboard.ts` | count what is uncovered, not what has no row |
| `app/api/sheets/overpayments/route.ts` *(new)* | list + create-refund-from-row |
| `app/dashboard/refunds/RefundsClient.tsx` | To check tab; outstanding-elsewhere prompt |
| `supabase/migrations/1xx_*.sql` | notice templates for the new reasons |

## Testing

The arithmetic is where money goes wrong silently, so it is extracted and
tested directly rather than through a mark:

- an unpaid customer's reduction creates no refund
- a partly-paid customer is refunded only what they overpaid, not the units' value
- a fully-paid customer is refunded the units' value
- several customers on one mark each get their own amount
- undoing a mark cancels its refund, and leaves one with a linked payment alone
- a mark's refund covering the whole overpayment leaves nothing To check
- a mark's refund covering part of it leaves exactly the remainder To check
- creating a refund from a To-check row clears that row and adds one to Pending
- a true overpayment with no mark behind it appears To check, and nowhere else
  until someone acts on it
- reconciling an `overpayment` row beside a mark's row excludes itself, so the
  two never claim the same money
- the Dashboard count and the To-check list always agree
- rows under the threshold are collapsed, counted and totalled, never dropped

The residual is computed in one tested function rather than written three times
in SQL — the detector, the list and the Dashboard must never disagree about how
much is owed.

## Not in this spec

- Auto-creating any refund from an overpayment. The 130 true overpayments are
  not lost — they appear To check, where a person decides.
- Applying a credit automatically. The prompt offers it; a person decides.
- Making the small-amount threshold configurable.
- Backfilling the 224 existing auto-created rows. They stay as they are.
- Marks writing adjustments to move the invoice itself.
- Any change to the cancellation flow.
- Backfilling reasons onto the 94 historical reduction-driven refunds.
