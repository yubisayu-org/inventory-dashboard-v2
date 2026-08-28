# Live Overpayment Amounts — Design

**Date:** 2026-08-28
**Status:** approved by the owner 28 Aug 2026; supersedes the parked
`feature/refunds-live-amounts` branch (12 Jul), which no longer applies

## The problem

An overpayment refund stores a number. That number is correct when written and
can stop being correct afterwards, because it describes a balance and balances
move.

`cindyalyssa_` · LSCN202606, from production:

```
24 Jun   invoice 2.541.000   paid 2.541.000    settled
 1 Jul   loafers cancelled → invoice 2.059.000 → she has overpaid 482.000
 1 Jul   refund written: Rp 482.000            correct
 5 Jul   she orders socks  → invoice 2.539.000 → she is owed Rp 2.000
today    the refund still says Rp 482.000
```

Pay that row as it stands and she receives **Rp 480.000 she is not owed**.

Production today handles this with a **review badge**: the stored amount is
kept, the live figure is computed on read, and an amber "Needs review" appears
when they differ. It works — it is why this row was found — but it depends on
somebody looking, and the wrong number is on the screen until they do.

## The decision

A refund's amount is **live while the refund is still being decided**, and
**frozen once it is settled**.

| refund | amount comes from | live? |
|---|---|---|
| overpayment, `pending` / `awaiting_bank_info` / `ready_to_refund` | her balance | **yes** |
| overpayment, `applied_to_next_order` (a deposit) | a decision she made | no |
| overpayment, `refunded` / `cancelled` | what was paid | no |
| goods (`unavailable`, `damaged`, `quality`, …), any status | the price of an item | no |

### Why goods refunds stay stored

A goods refund is the price of a thing you could not buy. The Bucket Hat is
Rp 160.000 whether or not she orders ten more items on that trip. Deriving it
from a balance would make it wrong.

This also means none of the 28 Aug mark-refund work is touched: the per-mark
cap, the one-row-per-customer merging, and the ongkir-inclusive reduction all
live on goods refunds.

### Why deposits stay stored

The owner's framing, and it is the right one: **a deposit is a fixed sum on her
account.** The moment she says "keep it", the money stops being a claim on a
trip and becomes hers, and where it came from stops mattering. Nothing about it
should move afterwards.

A deposit is also, in practice, chosen after a trip is finished — so there is
nothing left to move under it.

## What changes

1. **A `live_balances` view** — invoice, paid, and balance per (event,
   customer), on normalized handles.
2. **`getRefunds`** returns the live figure for a live refund, and the stored
   one otherwise.
3. **`executeRefund`** pays the live figure at the moment of transfer, and
   writes it to the row as it freezes.
4. **`applyRefundAsCredit`** caps against the live figure for a live refund.
5. **`listOverpaymentsToCheck`** stops summing stored amounts for live refunds:
   an open overpayment refund covers whatever is currently overpaid.
6. **The review badge goes.** `attachStaleReview`, `liveOverpayment`, and
   `reviewMessage` are deleted — nothing can drift, so there is nothing to warn
   about.

## Handle normalization

The 12 July branch's view joined `customers.instagram_id = orders.customer`
exactly. That predates the handle work: `@Fandrianr` and `fandrianr` are one
person, and an exact join silently matches neither. Every join in the new view
uses `lower(replace(x, '@', ''))`, the same shape `getPaymentStatus` uses.

## Free-text reasons exist

Production holds a refund whose reason is the literal string `"Out of stock"`,
not the canonical `unavailable`. Anything that switches on reason must treat an
unknown reason as **stored**, never assume it is one of the known kinds.

## Not in this spec

- Changing what a goods refund's amount means.
- Changing deposits, the deposit banner, or the 💰 marker.
- Backfilling or correcting the rows already written.
