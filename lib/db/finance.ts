import sql from "../db-pool"
import { normalizeId, tsToString, normalizeCustomer } from "./helpers"
import type { DBExecutor } from "./actor"
import type { PaymentRow, AdjustmentRow, RefundRow, RefundReason, RefundStatus } from "./types"

// ─── Payments ──────────────────────────────────────────────────────────────

function mapPaymentRow(r: Record<string, unknown>): PaymentRow {
  return {
    rowNumber: r.id as number,
    event: r.event as string,
    customer: r.customer as string,
    amount: (r.amount as number) ?? 0,
    account: (r.account as string) ?? "",
    isChecked: (r.is_checked as boolean) ?? false,
    payDate: r.pay_date ? new Date(r.pay_date as string).toISOString().slice(0, 10) : "",
    remarks: (r.remarks as string) ?? "",
    kind: (r.kind as PaymentRow["kind"]) ?? "deposit",
    createdAt: tsToString(r.created_at as Date | null),
    updatedAt: tsToString(r.updated_at as Date | null),
  }
}

export async function getPaymentRows(): Promise<PaymentRow[]> {
  const rows = await sql`
    SELECT id, event, customer, amount, account, is_checked,
           pay_date, remarks, kind, created_at, updated_at
    FROM payments ORDER BY id DESC
  `
  return rows.map(mapPaymentRow)
}

export interface PaginatedPayments {
  rows: PaymentRow[]
  totalCount: number
  filteredSum: number | null  // null when skipCount=true (use cached value client-side)
  page: number
  pageSize: number
  totalPages: number
}

/** Sentinel for totalCount/totalPages when skipCount was requested. */
export const PAYMENTS_TOTAL_COUNT_UNCHANGED = -1

/**
 * One page of payments with server-side search/filter/sort. The payments table
 * is one of the largest (many per customer × event over time), so loading it
 * all on every page open is slow — this bounds it. Mirrors getCustomersPaginated.
 */
export async function getPaymentsPaginated(opts: {
  page: number
  pageSize: number
  search?: string
  event?: string
  customer?: string
  account?: string
  remarks?: string
  kind?: string
  isChecked?: boolean
  sortKey?: string
  sortDir?: "asc" | "desc"
  skipCount?: boolean
}): Promise<PaginatedPayments> {
  const { page, pageSize, search, skipCount } = opts
  const offset = (page - 1) * pageSize

  const conditions: string[] = []
  const params: (string | number | boolean)[] = []

  if (search) {
    params.push(`%${search.toLowerCase()}%`)
    const p = `$${params.length}`
    const ors = [
      `lower(event) LIKE ${p}`,
      `lower(customer) LIKE ${p}`,
      `lower(COALESCE(account,'')) LIKE ${p}`,
      `lower(COALESCE(remarks,'')) LIKE ${p}`,
    ]
    // Amount search: amounts are whole numbers shown with thousand separators
    // (e.g. "762.000"), so strip dots/commas/spaces and, if what's left is all
    // digits, match it against the numeric amount as text. Cast via bigint so a
    // numeric column's trailing ".00" never breaks the match.
    const digits = search.replace(/[.,\s]/g, "")
    if (/^\d+$/.test(digits)) {
      params.push(`%${digits}%`)
      ors.push(`CAST(amount AS BIGINT)::text LIKE $${params.length}`)
    }
    conditions.push(`(${ors.join(" OR ")})`)
  }

  const textFilters: [string | undefined, string][] = [
    [opts.event, "event"],
    [opts.customer, "customer"],
    [opts.account, "account"],
    [opts.remarks, "remarks"],
    [opts.kind, "kind"],
  ]
  for (const [value, col] of textFilters) {
    if (value) {
      params.push(`%${value.toLowerCase()}%`)
      conditions.push(`lower(COALESCE(${col},'')) LIKE $${params.length}`)
    }
  }
  if (typeof opts.isChecked === "boolean") {
    params.push(opts.isChecked)
    conditions.push(`is_checked = $${params.length}`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const SORT_COLUMNS: Record<string, string> = {
    event: "event", customer: "customer", amount: "amount", kind: "kind",
    account: "account", payDate: "pay_date", remarks: "remarks",
    createdAt: "created_at", updatedAt: "updated_at",
  }
  const sortCol = (opts.sortKey && SORT_COLUMNS[opts.sortKey]) || "id"
  const sortDir = opts.sortDir === "asc" ? "ASC" : "DESC"

  const dataRows = await sql.unsafe(
    `SELECT id, event, customer, amount, account, is_checked,
            pay_date, remarks, kind, created_at, updated_at
     FROM payments
     ${where}
     ORDER BY ${sortCol} ${sortDir}, id ${sortDir}
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )
  const rows = dataRows.map(mapPaymentRow)

  if (skipCount) {
    return { rows, totalCount: PAYMENTS_TOTAL_COUNT_UNCHANGED, filteredSum: null, page, pageSize, totalPages: PAYMENTS_TOTAL_COUNT_UNCHANGED }
  }

  const [countRows, sumRows] = await Promise.all([
    sql.unsafe(`SELECT COUNT(*)::int AS c FROM payments ${where}`, params),
    sql.unsafe(`SELECT COALESCE(SUM(amount), 0)::bigint AS s FROM payments ${where}`, params),
  ])
  const totalCount = Number((countRows as Record<string, unknown>[])[0]?.c ?? 0)
  const filteredSum = Number((sumRows as Record<string, unknown>[])[0]?.s ?? 0)
  return { rows, totalCount, filteredSum, page, pageSize, totalPages: Math.max(1, Math.ceil(totalCount / pageSize)) }
}

export async function addPayment(data: {
  event: string
  customer: string
  amount: number
  account: string
  isChecked: boolean
  payDate: string
  remarks: string
}, db: DBExecutor = sql): Promise<{ rowNumber: number }> {
  const customer = normalizeCustomer(data.customer)
  await db`
    INSERT INTO customers (instagram_id) VALUES (${customer})
    ON CONFLICT (instagram_id) DO NOTHING
  `
  const [row] = await db`
    INSERT INTO payments (event, customer, amount, account, is_checked, pay_date, remarks)
    VALUES (${data.event}, ${customer}, ${data.amount}, ${data.account}, ${data.isChecked}, ${data.payDate || null}, ${data.remarks})
    RETURNING id
  `
  return { rowNumber: row.id }
}

export async function updatePayment(
  rowNumber: number,
  data: {
    event: string
    customer: string
    amount: number
    account: string
    isChecked: boolean
    payDate: string
    remarks: string
  },
  db: DBExecutor = sql,
): Promise<void> {
  const customer = normalizeCustomer(data.customer)
  await db`
    INSERT INTO customers (instagram_id) VALUES (${customer})
    ON CONFLICT (instagram_id) DO NOTHING
  `
  await db`
    UPDATE payments
    SET event = ${data.event}, customer = ${customer}, amount = ${data.amount},
        account = ${data.account}, is_checked = ${data.isChecked},
        pay_date = ${data.payDate || null}, remarks = ${data.remarks}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function getPaymentChecked(rowNumber: number): Promise<boolean> {
  const [row] = await sql`SELECT is_checked FROM payments WHERE id = ${rowNumber}`
  return row?.is_checked ?? false
}

export async function togglePaymentChecked(
  rowNumber: number,
  isChecked: boolean,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE payments SET is_checked = ${isChecked}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function updatePaymentRemarks(rowNumber: number, remarks: string, db: DBExecutor = sql): Promise<void> {
  await db`
    UPDATE payments SET remarks = ${remarks}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function deletePayment(rowNumber: number, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM payments WHERE id = ${rowNumber}`
}

// ─── Adjustments ───────────────────────────────────────────────────────────

export async function getAdjustmentRows(): Promise<AdjustmentRow[]> {
  const rows = await sql`
    SELECT id, event, customer, description, amount, created_at, updated_at
    FROM adjustments ORDER BY id DESC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    event: r.event,
    customer: r.customer,
    description: r.description ?? "",
    amount: r.amount ?? 0,
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

export async function addAdjustment(data: {
  event: string
  customer: string
  description: string
  amount: number
}, db: DBExecutor = sql): Promise<{ rowNumber: number }> {
  const customer = normalizeCustomer(data.customer)
  await db`
    INSERT INTO customers (instagram_id) VALUES (${customer})
    ON CONFLICT (instagram_id) DO NOTHING
  `
  const [row] = await db`
    INSERT INTO adjustments (event, customer, description, amount)
    VALUES (${data.event}, ${customer}, ${data.description}, ${data.amount})
    RETURNING id
  `
  return { rowNumber: row.id }
}

export async function updateAdjustment(
  rowNumber: number,
  data: {
    event: string
    customer: string
    description: string
    amount: number
  },
  db: DBExecutor = sql,
): Promise<void> {
  const customer = normalizeCustomer(data.customer)
  await db`
    INSERT INTO customers (instagram_id) VALUES (${customer})
    ON CONFLICT (instagram_id) DO NOTHING
  `
  await db`
    UPDATE adjustments
    SET event = ${data.event}, customer = ${customer},
        description = ${data.description}, amount = ${data.amount},
        updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function deleteAdjustment(rowNumber: number, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM adjustments WHERE id = ${rowNumber}`
}

// ─── Refunds ─────────────────────────────────────────────────────────────────

function mapRefundRow(r: Record<string, unknown>): RefundRow {
  return {
    id: r.id as number,
    event: r.event as string,
    customer: r.customer as string,
    reason: r.reason as RefundReason,
    // getRefunds computes live_refund_amount (live balance for open overpayment
    // rows, stored column otherwise); other call sites (RETURNING *) fall back
    // to the stored column.
    refundAmount: (r.live_refund_amount as number | undefined) ?? (r.refund_amount as number),
    status: r.status as RefundStatus,
    bankName: (r.bank_name as string) ?? "",
    bankAccountNumber: (r.bank_account_number as string) ?? "",
    bankAccountHolder: (r.bank_account_holder as string) ?? "",
    transferReference: (r.transfer_reference as string) ?? "",
    paymentId: (r.payment_id as number | null) ?? null,
    orderId: (r.order_id as number | null) ?? null,
    affectedUnits: (r.affected_units as number) ?? 0,
    note: (r.note as string) ?? "",
    hasAppliedCredit: Boolean(r.has_applied_credit),
    appliedCreditAmount: (r.applied_credit_amount as number) ?? 0,
    createdAt: tsToString(r.created_at as Date | null | undefined),
    updatedAt: tsToString(r.updated_at as Date | null | undefined),
  }
}

/** Statuses in which an overpayment refund's amount is live-derived, not stored. */
const OPEN_REFUND_STATUSES: RefundStatus[] = ["pending", "awaiting_bank_info", "ready_to_refund"]

export async function getRefunds(filters?: { event?: string; status?: string; customer?: string }): Promise<RefundRow[]> {
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (filters?.event) {
    params.push(filters.event)
    conditions.push(`r.event = $${params.length}`)
  }
  if (filters?.status) {
    params.push(filters.status)
    conditions.push(`r.status = $${params.length}`)
  }
  if (filters?.customer) {
    params.push(normalizeId(filters.customer))
    conditions.push(`lower(replace(r.customer, '@', '')) = $${params.length}`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
  // Open = live, closed = frozen: an open overpayment refund's amount is the
  // live balance from the ledger (never stale, by construction — credit legs
  // and cash payouts are payments, so they already reduce total_paid). Closed
  // rows and manual-reason refunds use the stored column.
  const rows = await sql.unsafe(
    `SELECT r.*,
            EXISTS (SELECT 1 FROM payments p WHERE p.refund_id = r.id AND p.kind = 'credit') AS has_applied_credit,
            (SELECT COALESCE(SUM(p.amount), 0)::int FROM payments p
             WHERE p.refund_id = r.id AND p.kind = 'credit' AND p.amount > 0) AS applied_credit_amount,
            CASE WHEN r.reason = 'overpayment'
                  AND r.status IN ('pending', 'awaiting_bank_info', 'ready_to_refund')
                 THEN GREATEST(COALESCE(lb.balance, 0), 0)
                 ELSE r.refund_amount END AS live_refund_amount
     FROM refunds r
     LEFT JOIN live_balances lb ON lb.event = r.event AND lb.customer = r.customer
     ${where} ORDER BY r.created_at DESC`,
    params,
  )
  return rows.map(mapRefundRow)
}

export async function createRefund(data: {
  event: string
  customer: string
  reason: RefundReason
  refundAmount: number
  orderId?: number | null
  affectedUnits?: number
  note?: string
}, db: DBExecutor = sql): Promise<RefundRow> {
  const customer = normalizeCustomer(data.customer)
  const [row] = await db`
    INSERT INTO refunds (event, customer, reason, refund_amount, order_id, affected_units, note)
    VALUES (
      ${data.event}, ${customer}, ${data.reason}, ${data.refundAmount},
      ${data.orderId ?? null}, ${data.affectedUnits ?? 0}, ${data.note ?? ""}
    )
    RETURNING *
  `
  return mapRefundRow(row)
}

export async function updateRefund(
  id: number,
  data: Partial<{
    status: RefundStatus
    refundAmount: number
    bankName: string
    bankAccountNumber: string
    bankAccountHolder: string
    transferReference: string
    note: string
  }>,
  db: DBExecutor = sql,
): Promise<void> {
  // Open overpayment refunds derive their amount live from the ledger — a
  // hand-set value would be silently overridden on the next read, so drop the
  // patch instead of storing a number that lies. Manual-reason refunds (and
  // closed rows) keep their stored amount editable.
  if (data.refundAmount !== undefined) {
    const [row] = await db`SELECT reason, status FROM refunds WHERE id = ${id}`
    if (
      row &&
      (row.reason as RefundReason) === "overpayment" &&
      OPEN_REFUND_STATUSES.includes(row.status as RefundStatus)
    ) {
      delete data.refundAmount
    }
  }

  const fields: string[] = []
  const params: (string | number)[] = []

  if (data.status !== undefined) { params.push(data.status); fields.push(`status = $${params.length}`) }
  if (data.refundAmount !== undefined) { params.push(data.refundAmount); fields.push(`refund_amount = $${params.length}`) }
  if (data.bankName !== undefined) { params.push(data.bankName); fields.push(`bank_name = $${params.length}`) }
  if (data.bankAccountNumber !== undefined) { params.push(data.bankAccountNumber); fields.push(`bank_account_number = $${params.length}`) }
  if (data.bankAccountHolder !== undefined) { params.push(data.bankAccountHolder); fields.push(`bank_account_holder = $${params.length}`) }
  if (data.transferReference !== undefined) { params.push(data.transferReference); fields.push(`transfer_reference = $${params.length}`) }
  if (data.note !== undefined) { params.push(data.note); fields.push(`note = $${params.length}`) }

  if (fields.length === 0) return
  params.push(id)
  await db.unsafe(
    `UPDATE refunds SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${params.length}`,
    params as (string | number)[],
  )
}

export async function executeRefund(
  refundId: number,
  transferReference: string,
  actor?: string | null,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    const [refund] = await tx`SELECT * FROM refunds WHERE id = ${refundId} FOR UPDATE`
    if (!refund) throw new Error("Refund not found")
    if (refund.status === "refunded") throw new Error("Refund already executed")

    // Open overpayment refunds pay out the LIVE balance at this exact moment
    // (the stored column is ignored while open); the −payment row below then
    // brings the balance to zero. Manual-reason refunds pay the stored amount.
    let amount = refund.refund_amount as number
    if (
      (refund.reason as RefundReason) === "overpayment" &&
      OPEN_REFUND_STATUSES.includes(refund.status as RefundStatus)
    ) {
      const [lb] = await tx`
        SELECT balance FROM live_balances
        WHERE event = ${refund.event as string} AND customer = ${refund.customer as string}
      `
      amount = Math.max(Number(lb?.balance ?? 0), 0)
    }
    if (!(amount > 0)) throw new Error("Nothing left to refund — the live balance is zero")

    const [payment] = await tx`
      INSERT INTO payments (event, customer, amount, account, is_checked, remarks, kind, refund_id)
      VALUES (
        ${refund.event as string},
        ${refund.customer as string},
        ${-amount},
        ${refund.bank_account_number as string},
        true,
        ${`Refund: ${refund.reason}`},
        'refund',
        ${refundId}
      )
      RETURNING id
    `
    // Terminal transition — freeze the paid amount into refund_amount as the
    // historical record ("open = live, closed = frozen").
    await tx`
      UPDATE refunds
      SET status             = 'refunded',
          refund_amount      = ${amount},
          transfer_reference = ${transferReference},
          bank_name          = ${refund.bank_name as string},
          bank_account_number = ${refund.bank_account_number as string},
          bank_account_holder = ${refund.bank_account_holder as string},
          payment_id         = ${payment.id as number},
          updated_at         = NOW()
      WHERE id = ${refundId}
    `
  })
}

export async function deleteRefund(id: number, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM refunds WHERE id = ${id} AND status != 'refunded'`
}

/**
 * Apply (part of) an overpayment as credit on another of the customer's orders,
 * instead of refunding cash. Moves money as a pair of `credit` payments in one
 * transaction:
 *   - −amount on the SOURCE event (the overpayment leaving) → no longer overpaid
 *     by that much;
 *   - +amount on the TARGET event → lowers what the customer owes there.
 * Both are is_checked (so they count toward total_paid immediately) and linked
 * to the refund via refund_id for a precise undo.
 *
 * Partial-friendly: `amount` may be less than the overpayment. For an
 * overpayment refund the remaining amount is live-derived (the −credit leg on
 * the source event lowers total_paid, so the live balance drops on its own —
 * nothing is stored while open). Fully applied → terminal
 * `applied_to_next_order` with refund_amount frozen at 0.
 */
export async function applyRefundAsCredit(
  refundId: number,
  targetEvent: string,
  amount: number,
  actor?: string | null,
): Promise<void> {
  const target = targetEvent?.trim()
  if (!target) throw new Error("Target order is required")
  if (!(amount > 0)) throw new Error("Amount must be positive")

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    const [refund] = await tx`SELECT * FROM refunds WHERE id = ${refundId} FOR UPDATE`
    if (!refund) throw new Error("Refund not found")
    if (refund.status === "refunded") throw new Error("Already refunded as cash — cannot also apply as credit")

    const sourceEvent = refund.event as string
    const reason = refund.reason as RefundReason
    const customer = normalizeCustomer(refund.customer as string)
    const isLiveAmount =
      reason === "overpayment" && OPEN_REFUND_STATUSES.includes(refund.status as RefundStatus)

    // Overpayment refunds: validate against the live balance, the only number
    // that's correct by construction. Manual-reason refunds: the stored amount.
    let remaining = refund.refund_amount as number
    if (isLiveAmount) {
      const [lb] = await tx`
        SELECT balance FROM live_balances
        WHERE event = ${sourceEvent} AND customer = ${refund.customer as string}
      `
      remaining = Math.max(Number(lb?.balance ?? 0), 0)
    }
    if (!(remaining > 0)) throw new Error("Nothing left to apply")
    if (amount > remaining) throw new Error(`Amount exceeds the overpayment (Rp ${remaining})`)

    if (target === sourceEvent) throw new Error("Pick a different order than the overpaid one")

    // The customer must actually have an order in the target event, or the
    // credit would dangle on an event they aren't part of.
    const [hasTarget] = await tx`
      SELECT 1 FROM orders
      WHERE event = ${target}
        AND lower(replace(customer, '@', '')) = lower(replace(${customer}, '@', ''))
      LIMIT 1
    `
    if (!hasTarget) throw new Error(`${customer} has no order in ${target}`)

    await tx`
      INSERT INTO payments (event, customer, amount, account, is_checked, remarks, kind, refund_id)
      VALUES (${sourceEvent}, ${customer}, ${-amount}, '', true,
              ${`Overpayment applied as credit to ${target}`}, 'credit', ${refundId})
    `
    await tx`
      INSERT INTO payments (event, customer, amount, account, is_checked, remarks, kind, refund_id)
      VALUES (${target}, ${customer}, ${amount}, '', true,
              ${`Credit from ${reason} on ${sourceEvent}`}, 'credit', ${refundId})
    `

    const newRemaining = remaining - amount
    if (newRemaining <= 0) {
      // Terminal — freeze at 0 ("open = live, closed = frozen").
      await tx`
        UPDATE refunds
        SET refund_amount = 0,
            status = 'applied_to_next_order',
            note = ${`Applied as credit to ${target}`},
            updated_at = NOW()
        WHERE id = ${refundId}
      `
    } else if (isLiveAmount) {
      // Still open: the live balance already reflects the −credit leg, so only
      // the note changes — no amount is stored.
      await tx`
        UPDATE refunds
        SET note = ${`Applied Rp ${amount} as credit to ${target}; Rp ${newRemaining} overpayment remaining`},
            updated_at = NOW()
        WHERE id = ${refundId}
      `
    } else {
      // Manual-reason refund: stored amount is the truth, keep decrementing.
      await tx`
        UPDATE refunds
        SET refund_amount = ${newRemaining},
            note = ${`Applied Rp ${amount} as credit to ${target}; Rp ${newRemaining} remaining`},
            updated_at = NOW()
        WHERE id = ${refundId}
      `
    }
  })
}

/**
 * Reverse the credit transfer(s) this refund produced — e.g. applied to the
 * wrong order. Deletes exactly the linked `credit` payments (matched by
 * refund_id) and reopens it as `pending`. For an overpayment refund the
 * amount needs no restoring — deleting the −credit leg raises total_paid
 * again, so the live balance recovers by construction. Manual-reason refunds
 * get their stored amount restored. Atomic. Does not touch a cash refund's
 * `refund` payment.
 */
export async function undoRefundCredit(refundId: number, actor?: string | null): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    const [refund] = await tx`SELECT refund_amount, reason FROM refunds WHERE id = ${refundId} FOR UPDATE`
    if (!refund) throw new Error("Refund not found")

    // The target (+) legs sum to how much was applied.
    const [applied] = await tx`
      SELECT COALESCE(SUM(amount), 0)::int AS total
      FROM payments WHERE refund_id = ${refundId} AND kind = 'credit' AND amount > 0
    `
    if (!(applied.total > 0)) throw new Error("No applied credit to undo")

    await tx`DELETE FROM payments WHERE refund_id = ${refundId} AND kind = 'credit'`
    if ((refund.reason as RefundReason) === "overpayment") {
      // Reopen; the live balance is the amount (stored column ignored while open).
      await tx`
        UPDATE refunds
        SET status = 'pending', note = '', updated_at = NOW()
        WHERE id = ${refundId}
      `
    } else {
      await tx`
        UPDATE refunds
        SET refund_amount = ${(refund.refund_amount as number) + (applied.total as number)},
            status = 'pending', note = '', updated_at = NOW()
        WHERE id = ${refundId}
      `
    }
  })
}

/**
 * Keeps the set of auto-detected overpayment refund TICKETS in step with the
 * ledger on every /refunds load. Amounts are not maintained here — open
 * overpayment refunds derive their amount live from the live_balances view at
 * read time ("open = live, closed = frozen"), so there is nothing to
 * reconcile. In one transaction it:
 *   - inserts a fresh pending refund for each (event, customer) pair now
 *     overpaid that has no active overpayment refund yet;
 *   - cancels any still-open overpayment refund whose live balance is no
 *     longer positive — including ones with credit already applied (the
 *     credit legs are real payments and stay untouched), and ones whose
 *     orders were all deleted (pair missing from the live set counts as 0).
 * A `refunded` (Done), `cancelled`, or `applied_to_next_order` refund is frozen,
 * and only `reason = 'overpayment'` rows are touched — hand-entered refunds keep
 * their human-set amounts.
 *
 * Idempotent — safe to call on every refunds page load.
 *
 * Returns the rows that were just inserted (empty array if nothing to do).
 */
// Fixed key for the advisory lock that serializes concurrent materialize runs.
const OVERPAYMENT_MATERIALIZE_LOCK = 778899

export async function materializeOverpaymentRefunds(): Promise<RefundRow[]> {
  const rows = await sql.begin(async (tx) => {
    // Serialize overlapping /refunds loads. The check-then-insert below isn't
    // atomic on its own — two concurrent runs could both pass the NOT EXISTS and
    // double-insert. The transaction-scoped advisory lock makes the second run
    // wait, then see the first run's committed rows and skip them. (The partial
    // unique index from migration 031 is the hard backstop.)
    await tx`SELECT pg_advisory_xact_lock(${OVERPAYMENT_MATERIALIZE_LOCK})`
    return tx`
    WITH
    -- Live balance is over-refundable when positive. Ticket bookkeeping only —
    -- amounts are read live elsewhere. Data-modifying CTEs run even when the
    -- primary query doesn't reference them.
    cancelled AS (
      UPDATE refunds r
      SET status = 'cancelled',
          refund_amount = 0,
          note = 'Auto-cancelled: overpayment resolved',
          updated_at = NOW()
      WHERE r.reason = 'overpayment'
        AND r.status IN ('pending', 'awaiting_bank_info', 'ready_to_refund')
        AND NOT EXISTS (
          SELECT 1 FROM live_balances lb
          WHERE lb.event = r.event AND lb.customer = r.customer
            AND lb.balance > 0
        )
      RETURNING r.id
    )
    -- Brand-new overpayments (no active refund row yet) become fresh pending
    -- rows. The inserted refund_amount is an informational snapshot; the UI
    -- always shows the live balance while the ticket is open.
    INSERT INTO refunds (event, customer, reason, refund_amount, note)
    SELECT
      lb.event,
      lb.customer,
      'overpayment',
      lb.balance,
      'Auto-detected: paid Rp ' || lb.total_paid || ' of Rp ' || lb.invoice_total
    FROM live_balances lb
    LEFT JOIN refunds r ON r.event = lb.event AND r.customer = lb.customer
      AND r.reason = 'overpayment' AND r.status != 'cancelled'
    WHERE r.id IS NULL
      AND lb.balance > 0
    RETURNING *
  `
  })
  return rows.map(mapRefundRow)
}

export type PaymentStatus = "void" | "unpaid" | "partial" | "paid" | "overpaid"

export interface PaymentStatusRow {
  event: string
  customer: string
  invoiceTotal: number
  totalPaid: number
  outstanding: number
  status: PaymentStatus
}

function paymentStatusFor(totalPaid: number, invoiceTotal: number): PaymentStatus {
  // Nothing owed and nothing paid → a void invoice (e.g. no orders, or orders
  // cancelled via adjustments). Paid-against-zero stays "overpaid" so the
  // refund-due signal isn't hidden.
  if (invoiceTotal === 0 && totalPaid === 0) return "void"
  if (totalPaid === 0) return "unpaid"
  if (totalPaid > invoiceTotal) return "overpaid"
  if (totalPaid === invoiceTotal) return "paid"
  return "partial"
}

/**
 * Per-(event, customer) payment status. With `event`, only that event's rows;
 * without, every event. Same invoice math as getInvoiceForCustomer
 * (orders + ongkir + adjustments, checked payments only). Customer handles are
 * normalized (lowercase, no "@") so legacy/normalized variants merge instead of
 * splitting into a bogus Unpaid + Overpaid pair.
 */
export async function getPaymentStatus(event?: string): Promise<PaymentStatusRow[]> {
  // When an event is given, push the filter into every event-keyed CTE so the
  // planner can use the (event, ...) indexes on orders/payments/adjustments
  // instead of aggregating the world and filtering in JS. customer_ongkir is
  // keyed by (event, customer) via the event's warehouse but stays unscoped by
  // the event filter — the join on (cust_key, event) still picks only the
  // customers that show up in the event's all_keys union.
  const rows = event
    ? await sql`
        WITH order_aggregates AS (
          SELECT o.event AS event,
                 lower(replace(o.customer, '@', '')) AS cust_key,
                 SUM(o.unit_price * o.unit) AS subtotal,
                 SUM(COALESCE(p.gram, 0) * o.unit) AS total_gram
          FROM orders o
          JOIN products p ON p.id = o.product_id
          WHERE o.event = ${event}
          GROUP BY o.event, lower(replace(o.customer, '@', ''))
        ),
        payment_aggregates AS (
          SELECT event, lower(replace(customer, '@', '')) AS cust_key, SUM(amount) AS total_paid
          FROM payments
          WHERE is_checked = true AND event = ${event}
          GROUP BY event, lower(replace(customer, '@', ''))
        ),
        adjustment_aggregates AS (
          SELECT event, lower(replace(customer, '@', '')) AS cust_key, SUM(amount) AS total_adj
          FROM adjustments
          WHERE event = ${event}
          GROUP BY event, lower(replace(customer, '@', ''))
        ),
        customer_ongkir AS (
          -- Per-(event, customer) ongkir from the event's warehouse.
          SELECT ev.name AS event,
                 lower(replace(c.instagram_id, '@', '')) AS cust_key,
                 COALESCE(cwo.ongkos_kirim, 0) AS ongkos_kirim
          FROM events ev
          JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
          JOIN customers c ON c.id = cwo.customer_id
        ),
        all_keys AS (
          SELECT event, cust_key FROM order_aggregates
          UNION
          SELECT event, cust_key FROM payment_aggregates
          UNION
          SELECT event, cust_key FROM adjustment_aggregates
        )
        SELECT
          k.event AS event,
          k.cust_key AS customer,
          (COALESCE(oa.subtotal, 0)
            + COALESCE(c.ongkos_kirim, 0) * CEIL(COALESCE(oa.total_gram, 0)::numeric / 1000)
            + COALESCE(adj.total_adj, 0))::int AS invoice_total,
          COALESCE(pa.total_paid, 0)::int AS total_paid
        FROM all_keys k
        LEFT JOIN order_aggregates oa ON oa.event = k.event AND oa.cust_key = k.cust_key
        LEFT JOIN customer_ongkir c ON c.cust_key = k.cust_key AND c.event = k.event
        LEFT JOIN payment_aggregates pa ON pa.event = k.event AND pa.cust_key = k.cust_key
        LEFT JOIN adjustment_aggregates adj ON adj.event = k.event AND adj.cust_key = k.cust_key
        ORDER BY k.event, k.cust_key
      `
    : await sql`
        WITH order_aggregates AS (
          SELECT o.event AS event,
                 lower(replace(o.customer, '@', '')) AS cust_key,
                 SUM(o.unit_price * o.unit) AS subtotal,
                 SUM(COALESCE(p.gram, 0) * o.unit) AS total_gram
          FROM orders o
          JOIN products p ON p.id = o.product_id
          GROUP BY o.event, lower(replace(o.customer, '@', ''))
        ),
        payment_aggregates AS (
          SELECT event, lower(replace(customer, '@', '')) AS cust_key, SUM(amount) AS total_paid
          FROM payments
          WHERE is_checked = true
          GROUP BY event, lower(replace(customer, '@', ''))
        ),
        adjustment_aggregates AS (
          SELECT event, lower(replace(customer, '@', '')) AS cust_key, SUM(amount) AS total_adj
          FROM adjustments
          GROUP BY event, lower(replace(customer, '@', ''))
        ),
        customer_ongkir AS (
          -- Per-(event, customer) ongkir from the event's warehouse.
          SELECT ev.name AS event,
                 lower(replace(c.instagram_id, '@', '')) AS cust_key,
                 COALESCE(cwo.ongkos_kirim, 0) AS ongkos_kirim
          FROM events ev
          JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
          JOIN customers c ON c.id = cwo.customer_id
        ),
        all_keys AS (
          SELECT event, cust_key FROM order_aggregates
          UNION
          SELECT event, cust_key FROM payment_aggregates
          UNION
          SELECT event, cust_key FROM adjustment_aggregates
        )
        SELECT
          k.event AS event,
          k.cust_key AS customer,
          (COALESCE(oa.subtotal, 0)
            + COALESCE(c.ongkos_kirim, 0) * CEIL(COALESCE(oa.total_gram, 0)::numeric / 1000)
            + COALESCE(adj.total_adj, 0))::int AS invoice_total,
          COALESCE(pa.total_paid, 0)::int AS total_paid
        FROM all_keys k
        LEFT JOIN order_aggregates oa ON oa.event = k.event AND oa.cust_key = k.cust_key
        LEFT JOIN customer_ongkir c ON c.cust_key = k.cust_key AND c.event = k.event
        LEFT JOIN payment_aggregates pa ON pa.event = k.event AND pa.cust_key = k.cust_key
        LEFT JOIN adjustment_aggregates adj ON adj.event = k.event AND adj.cust_key = k.cust_key
        ORDER BY k.event, k.cust_key
      `

  return rows.map((r) => {
    const invoiceTotal = Number(r.invoice_total)
    const totalPaid = Number(r.total_paid)
    return {
      event: r.event as string,
      customer: r.customer as string,
      invoiceTotal,
      totalPaid,
      outstanding: invoiceTotal - totalPaid,
      status: paymentStatusFor(totalPaid, invoiceTotal),
    }
  })
}

