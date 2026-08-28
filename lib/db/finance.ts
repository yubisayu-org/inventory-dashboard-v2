import sql from "../db-pool"
import { normalizeId, tsToString, normalizeCustomer } from "./helpers"
import { getInvoiceForCustomer } from "./invoice"
import type { DBExecutor } from "./actor"
import type { PaymentRow, AdjustmentRow, RefundRow, RefundReason, RefundStatus } from "./types"
import { isLiveAmount } from "./live-refund"

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
    rejectedAt: r.rejected_at ? tsToString(r.rejected_at as Date) : null,
    rejectReason: (r.reject_reason as string) ?? "",
    createdAt: tsToString(r.created_at as Date | null),
    updatedAt: tsToString(r.updated_at as Date | null),
  }
}

export async function getPaymentRows(): Promise<PaymentRow[]> {
  const rows = await sql`
    SELECT id, event, customer, amount, account, is_checked,
           pay_date, remarks, kind, created_at, updated_at,
           rejected_at, reject_reason
    FROM payments ORDER BY id DESC
  `
  return rows.map(mapPaymentRow)
}

export interface PaginatedPayments {
  rows: PaymentRow[]
  totalCount: number
  filteredSum: number | null  // null when skipCount=true (use cached value client-side)
  // Per-kind sums for the stat cards. Break down by type under the active
  // filters, ignoring the type-tab filter. null when skipCount=true.
  depositSum: number | null
  refundSum: number | null
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
  dateFrom?: string
  dateTo?: string
  isChecked?: boolean
  /** true = only refused rows, false = only live ones, undefined = both. */
  rejected?: boolean
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
  ]
  for (const [value, col] of textFilters) {
    if (value) {
      params.push(`%${value.toLowerCase()}%`)
      conditions.push(`lower(COALESCE(${col},'')) LIKE $${params.length}`)
    }
  }
  if (typeof opts.isChecked === "boolean") {
    params.push(opts.isChecked)
    // "Unchecked" means still to decide. A refused payment has been decided,
    // so it belongs in Rejected rather than ageing in the queue for ever.
    conditions.push(
      opts.isChecked
        ? `is_checked = $${params.length}`
        : `is_checked = $${params.length} AND rejected_at IS NULL`,
    )
  }
  if (opts.rejected === true) conditions.push("rejected_at IS NOT NULL")
  if (opts.rejected === false) conditions.push("rejected_at IS NULL")
  // Inclusive date range on pay_date (a DATE column); either bound optional.
  if (opts.dateFrom) {
    params.push(opts.dateFrom)
    conditions.push(`pay_date >= $${params.length}`)
  }
  if (opts.dateTo) {
    params.push(opts.dateTo)
    conditions.push(`pay_date <= $${params.length}`)
  }

  // Snapshot the WHERE *before* the kind filter so the deposit/credit/refund
  // stat cards always break down across all three types under the other active
  // filters — switching the type tab must not zero out two of the cards.
  const conditionsNoKind = [...conditions]
  const paramsNoKind = [...params]
  const whereNoKind = conditionsNoKind.length > 0 ? `WHERE ${conditionsNoKind.join(" AND ")}` : ""

  if (opts.kind) {
    params.push(`%${opts.kind.toLowerCase()}%`)
    conditions.push(`lower(COALESCE(kind,'')) LIKE $${params.length}`)
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
            pay_date, remarks, kind, created_at, updated_at,
            rejected_at, reject_reason
     FROM payments
     ${where}
     ORDER BY ${sortCol} ${sortDir}, id ${sortDir}
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )
  const rows = dataRows.map(mapPaymentRow)

  if (skipCount) {
    return { rows, totalCount: PAYMENTS_TOTAL_COUNT_UNCHANGED, filteredSum: null, depositSum: null, refundSum: null, page, pageSize, totalPages: PAYMENTS_TOTAL_COUNT_UNCHANGED }
  }

  const [countRows, sumRows, kindSumRows] = await Promise.all([
    sql.unsafe(`SELECT COUNT(*)::int AS c FROM payments ${where}`, params),
    sql.unsafe(`SELECT COALESCE(SUM(amount), 0)::bigint AS s FROM payments ${where}`, params),
    // Per-kind breakdown ignores the type-tab filter (whereNoKind). "deposit" is
    // the default/fallback kind, so anything not credit/refund counts as deposit.
    sql.unsafe(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE lower(COALESCE(kind,'')) NOT IN ('credit','refund')), 0)::bigint AS deposit,
         COALESCE(SUM(amount) FILTER (WHERE lower(kind) = 'refund'), 0)::bigint AS refund
       FROM payments ${whereNoKind}`,
      paramsNoKind,
    ),
  ])
  const totalCount = Number((countRows as Record<string, unknown>[])[0]?.c ?? 0)
  const filteredSum = Number((sumRows as Record<string, unknown>[])[0]?.s ?? 0)
  const kindRow = (kindSumRows as Record<string, unknown>[])[0]
  const depositSum = Number(kindRow?.deposit ?? 0)
  const refundSum = Number(kindRow?.refund ?? 0)
  return { rows, totalCount, filteredSum, depositSum, refundSum, page, pageSize, totalPages: Math.max(1, Math.ceil(totalCount / pageSize)) }
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

/** Every non-empty description ever used, so the description picker's
 *  autocomplete keeps offering previously typed-in values, not just the
 *  built-in presets (Free Shipping, Shipping Difference). */
export async function getDistinctAdjustmentDescriptions(): Promise<string[]> {
  const rows = await sql`
    SELECT DISTINCT description FROM adjustments
    WHERE description IS NOT NULL AND description != ''
    ORDER BY description
  `
  return rows.map((r) => r.description as string)
}

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

/** Every payment, adjustment and refund for one customer — the ledger half of
 *  the customer detail drawer (invoices come from getInvoiceForCustomer). Row
 *  counts per customer are small, so these are unpaginated. */
export interface CustomerLedger {
  payments: PaymentRow[]
  adjustments: AdjustmentRow[]
  refunds: RefundRow[]
}

export async function getCustomerLedger(instagramId: string): Promise<CustomerLedger> {
  const [payments, adjustments, refunds] = await Promise.all([
    sql`
      SELECT id, event, customer, amount, account, is_checked,
             pay_date, remarks, kind, created_at, updated_at
      FROM payments
      WHERE lower(customer) = lower(${instagramId})
      ORDER BY id DESC
    `.then((rows) => rows.map(mapPaymentRow)),
    sql`
      SELECT id, event, customer, description, amount, created_at, updated_at
      FROM adjustments
      WHERE lower(customer) = lower(${instagramId})
      ORDER BY id DESC
    `.then((rows) =>
      rows.map((r) => ({
        rowNumber: r.id as number,
        event: r.event as string,
        customer: r.customer as string,
        description: (r.description ?? "") as string,
        amount: (r.amount ?? 0) as number,
        createdAt: tsToString(r.created_at),
        updatedAt: tsToString(r.updated_at),
      })),
    ),
    getRefunds({ customer: instagramId }),
  ])
  return { payments, adjustments, refunds }
}

export interface PaginatedAdjustments {
  rows: AdjustmentRow[]
  totalCount: number
  filteredSum: number | null
  page: number
  pageSize: number
  totalPages: number
}

/** Sentinel for totalCount/totalPages when skipCount was requested. */
export const ADJUSTMENTS_TOTAL_COUNT_UNCHANGED = -1

/**
 * One page of adjustments with server-side search/filter/sort. Mirrors
 * getPaymentsPaginated so the Adjustments table matches the Payments table.
 */
export async function getAdjustmentsPaginated(opts: {
  page: number
  pageSize: number
  search?: string
  event?: string
  customer?: string
  description?: string
  dateFrom?: string
  dateTo?: string
  sortKey?: string
  sortDir?: "asc" | "desc"
  skipCount?: boolean
}): Promise<PaginatedAdjustments> {
  const { page, pageSize, search, skipCount } = opts
  const offset = (page - 1) * pageSize

  const conditions: string[] = []
  const params: (string | number)[] = []

  if (search) {
    params.push(`%${search.toLowerCase()}%`)
    const p = `$${params.length}`
    const ors = [
      `lower(event) LIKE ${p}`,
      `lower(customer) LIKE ${p}`,
      `lower(COALESCE(description,'')) LIKE ${p}`,
    ]
    const digits = search.replace(/[.,\s-]/g, "")
    if (/^\d+$/.test(digits)) {
      params.push(`%${digits}%`)
      ors.push(`CAST(amount AS BIGINT)::text LIKE $${params.length}`)
    }
    conditions.push(`(${ors.join(" OR ")})`)
  }

  const textFilters: [string | undefined, string][] = [
    [opts.event, "event"],
    [opts.customer, "customer"],
    [opts.description, "description"],
  ]
  for (const [value, col] of textFilters) {
    if (value) {
      params.push(`%${value.toLowerCase()}%`)
      conditions.push(`lower(COALESCE(${col},'')) LIKE $${params.length}`)
    }
  }
  // Inclusive date range on the created_at day (timestamptz → ::date).
  if (opts.dateFrom) {
    params.push(opts.dateFrom)
    conditions.push(`created_at::date >= $${params.length}`)
  }
  if (opts.dateTo) {
    params.push(opts.dateTo)
    conditions.push(`created_at::date <= $${params.length}`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const SORT_COLUMNS: Record<string, string> = {
    event: "event", customer: "customer", description: "description",
    amount: "amount", createdAt: "created_at", updatedAt: "updated_at",
  }
  const sortCol = (opts.sortKey && SORT_COLUMNS[opts.sortKey]) || "id"
  const sortDir = opts.sortDir === "asc" ? "ASC" : "DESC"

  const dataRows = await sql.unsafe(
    `SELECT id, event, customer, description, amount, created_at, updated_at
     FROM adjustments
     ${where}
     ORDER BY ${sortCol} ${sortDir}, id ${sortDir}
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )
  const rows: AdjustmentRow[] = (dataRows as Record<string, unknown>[]).map((r) => ({
    rowNumber: r.id as number,
    event: r.event as string,
    customer: r.customer as string,
    description: (r.description as string) ?? "",
    amount: (r.amount as number) ?? 0,
    createdAt: tsToString(r.created_at as Date | null),
    updatedAt: tsToString(r.updated_at as Date | null),
  }))

  if (skipCount) {
    return { rows, totalCount: ADJUSTMENTS_TOTAL_COUNT_UNCHANGED, filteredSum: null, page, pageSize, totalPages: ADJUSTMENTS_TOTAL_COUNT_UNCHANGED }
  }

  const [countRows, sumRows] = await Promise.all([
    sql.unsafe(`SELECT COUNT(*)::int AS c FROM adjustments ${where}`, params),
    sql.unsafe(`SELECT COALESCE(SUM(amount), 0)::bigint AS s FROM adjustments ${where}`, params),
  ])
  const totalCount = Number((countRows as Record<string, unknown>[])[0]?.c ?? 0)
  const filteredSum = Number((sumRows as Record<string, unknown>[])[0]?.s ?? 0)
  return { rows, totalCount, filteredSum, page, pageSize, totalPages: Math.max(1, Math.ceil(totalCount / pageSize)) }
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
  if (balance == null) return stored
  // Her surplus, less what the open goods refunds on this trip already claim of
  // it. Both read the same balance: a mark drops the invoice, which is what
  // creates the surplus the goods refund is paid out of -- so an overpayment
  // filed before that mark would count the same money a second time and the
  // two together would promise more than she is overpaid.
  const claimed = (r.other_claims as number | null | undefined) ?? 0
  return Math.max(0, balance - claimed)
}

/**
 * What the open goods refunds on this (event, customer) still claim.
 *
 * Only the ones still waiting to be sent. A refund already transferred has a
 * payment row lowering her balance, so subtracting it again would hide money
 * she is genuinely owed; a credit already applied moved its money the same way.
 * Overpayment refunds are excluded because they ARE this figure -- there is
 * only ever one active per pair, and it cannot claim against itself.
 */
const OTHER_CLAIMS_SQL = `
  SELECT COALESCE(SUM(r2.refund_amount), 0)::int
    FROM refunds r2
   WHERE r2.event = $EVENT
     AND lower(replace(r2.customer, '@', '')) = $CUSTKEY
     AND r2.id <> $SELF
     AND r2.reason <> 'overpayment'
     AND r2.status IN ('pending', 'awaiting_bank_info', 'ready_to_refund')`

/** The same figure, for a single refund, inside whatever transaction is open. */
async function otherOpenClaims(
  db: DBExecutor,
  refund: { id: number; event: string; customer: string },
): Promise<number> {
  const [row] = (await db`
    SELECT COALESCE(SUM(r2.refund_amount), 0)::int AS claimed
      FROM refunds r2
     WHERE r2.event = ${refund.event}
       AND lower(replace(r2.customer, '@', '')) = lower(replace(${refund.customer}, '@', ''))
       AND r2.id <> ${refund.id}
       AND r2.reason <> 'overpayment'
       AND r2.status IN ('pending', 'awaiting_bank_info', 'ready_to_refund')
  `) as unknown as { claimed: number }[]
  return row?.claimed ?? 0
}

function mapRefundRow(r: Record<string, unknown>): RefundRow {
  return {
    id: r.id as number,
    event: r.event as string,
    customer: r.customer as string,
    reason: r.reason as RefundReason,
    refundAmount: liveAmount(r),
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
  const rows = await sql.unsafe(
    `SELECT r.*,
            EXISTS (SELECT 1 FROM payments p WHERE p.refund_id = r.id AND p.kind = 'credit') AS has_applied_credit,
            (SELECT COALESCE(SUM(p.amount), 0)::int FROM payments p
             WHERE p.refund_id = r.id AND p.kind = 'credit' AND p.amount > 0) AS applied_credit_amount,
            lb.balance AS live_balance,
            (${OTHER_CLAIMS_SQL
                .replace("$EVENT", "r.event")
                .replace("$CUSTKEY", "lower(replace(r.customer, '@', ''))")
                .replace("$SELF", "r.id")}) AS other_claims
     FROM refunds r
     LEFT JOIN live_balances lb
            ON lb.event = r.event
           AND lb.customer = lower(replace(r.customer, '@', ''))
     ${where} ORDER BY r.created_at DESC`,
    params,
  )
  return rows.map(mapRefundRow)
}

/** Every reason value ever used, so the reason picker's autocomplete keeps
 *  offering previously typed-in values (not just the built-in presets). */
export async function getDistinctRefundReasons(): Promise<string[]> {
  const rows = await sql`SELECT DISTINCT reason FROM refunds ORDER BY reason`
  return rows.map((r) => r.reason as string)
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
    /**
     * Refused, always.
     *
     * Every amount in the system is either computed or typed once, at the
     * moment the refund is made: a mark works out what the reduction cost her,
     * an overpayment reads her balance, and a refund raised by hand takes the
     * figure the composer was given -- which is where refunding less than the
     * price belongs, because that is a decision about what is owed, not a
     * correction of it.
     *
     * Editing afterwards made a fourth kind of amount, one with no reasoning
     * attached and nothing to check it against. A wrong refund is cancelled or
     * deleted and made again, which leaves a record of the change instead of
     * quietly replacing the number.
     */
    refundAmount: never
    bankName: string
    bankAccountNumber: string
    bankAccountHolder: string
    transferReference: string
    note: string
  }>,
  db: DBExecutor = sql,
): Promise<void> {
  if (data.refundAmount !== undefined) {
    throw new Error("A refund's amount is set when it is made. Cancel it and make a new one.")
  }

  const fields: string[] = []
  const params: (string | number)[] = []

  if (data.status !== undefined) { params.push(data.status); fields.push(`status = $${params.length}`) }
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
  account: string,
  actor?: string | null,
): Promise<void> {
  const [refund] = await sql`SELECT * FROM refunds WHERE id = ${refundId}`
  if (!refund) throw new Error("Refund not found")
  if (refund.status === "refunded") throw new Error("Refund already executed")

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`

    // Re-read at the moment of transfer, not when the screen was opened. This
    // is the last point at which the figure can still be right, so it is the
    // one that decides what leaves the bank -- and what the row freezes at.
    let amount = refund.refund_amount as number
    if (isLiveAmount({ reason: refund.reason as string, status: refund.status as string })) {
      const [live] = (await tx`
        SELECT balance FROM live_balances
         WHERE event = ${refund.event as string}
           AND customer = lower(replace(${refund.customer as string}, '@', ''))
      `) as unknown as { balance: number }[]
      const claimed = await otherOpenClaims(tx, {
        id: refundId, event: refund.event as string, customer: refund.customer as string,
      })
      amount = Math.max(0, (live?.balance ?? 0) - claimed)
    }
    if (!(amount > 0)) {
      throw new Error("There is nothing owed on this refund any more")
    }

    // `account` is OUR bank the refund was sent from (BCA/JAGO/...), matching
    // what the column means on every other payment row. The customer's
    // receiving bank details stay on the refunds row.
    const [payment] = await tx`
      INSERT INTO payments (event, customer, amount, account, is_checked, remarks, kind, refund_id)
      VALUES (
        ${refund.event as string},
        ${refund.customer as string},
        ${-amount},
        ${account},
        true,
        ${`Refund: ${refund.reason}`},
        'refund',
        ${refundId}
      )
      RETURNING id
    `
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

/**
 * Pay several of one customer's refunds on one trip with a single transfer.
 *
 * A trip can owe her three separate things -- an item that never arrived, one
 * that arrived broken, and a transfer she typed wrong -- and each is its own
 * row because each is its own explanation, and because a report that cannot
 * tell damaged from unavailable teaches nobody anything. None of that is a
 * reason to open the banking app three times.
 *
 * So the rows stay split and the payout is joined: one reference, one account,
 * one press. Each refund still writes its OWN payment row carrying its own
 * refund_id and its own reason -- that link is what undo, the audit trail and
 * every per-reason total are built on, and merging the payments would buy
 * nothing and break all three. The bank sees one transfer because they share a
 * reference.
 *
 * Refuses the lot rather than paying part of it: a group spanning two customers
 * or two trips, or containing something already refunded, is a mistake about
 * what is being paid, and finding out afterwards is worse than not starting.
 *
 * A refund whose live figure has fallen to nothing since the screen opened is
 * skipped and named, not silently paid.
 */
export async function executeRefundGroup(
  refundIds: number[],
  transferReference: string,
  account: string,
  actor?: string | null,
  /**
   * Where the money went. Paying from the Pending tab means none of the rows
   * has been through the bank-info step, so the details come from the screen
   * instead -- prefilled from her customer record, and typed if she has none.
   * Omitted, the row that was open supplies them, as the drawer's flow does.
   */
  bank?: { name: string; accountNumber: string; accountHolder: string },
): Promise<{
  paid: { id: number; amount: number }[]
  skipped: { id: number; reason: string }[]
  total: number
}> {
  if (refundIds.length === 0) throw new Error("Pick at least one refund to pay")

  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`

    const rows = (await tx`
      SELECT * FROM refunds WHERE id = ANY(${refundIds}) ORDER BY id FOR UPDATE
    `) as unknown as Record<string, unknown>[]
    if (rows.length !== refundIds.length) throw new Error("One of those refunds no longer exists")

    const event = rows[0].event as string
    const who = normalizeCustomer(rows[0].customer as string)
    for (const r of rows) {
      if (r.event !== event || normalizeCustomer(r.customer as string) !== who) {
        throw new Error("These refunds are not all for the same customer on the same trip")
      }
      if (r.status === "refunded") throw new Error("One of those refunds has already been sent")
      if (r.status === "cancelled") throw new Error("One of those refunds was cancelled")
    }

    // One account is receiving the money, so one set of bank details describes
    // the transfer. Taken from the row that was open -- the first id the caller
    // passed -- because that is the one whose details were checked against her
    // message. The rows come back ordered by id, which need not be that one.
    const primary = rows.find((r) => r.id === refundIds[0]) ?? rows[0]
    const bankName = bank ? bank.name : ((primary.bank_name as string) ?? "")
    const bankAccountNumber = bank
      ? bank.accountNumber
      : ((primary.bank_account_number as string) ?? "")
    const bankAccountHolder = bank
      ? bank.accountHolder
      : ((primary.bank_account_holder as string) ?? "")
    // Never into a blank. The status walk exists because somebody had to ask
    // her for this and she had to answer; paying from Pending skips both, which
    // is right when her account is already on file and wrong when it is not.
    if (!bankAccountNumber.trim()) {
      throw new Error("She has no account number on file. Ask her for it before sending.")
    }

    const paid: { id: number; amount: number }[] = []
    const skipped: { id: number; reason: string }[] = []

    for (const r of rows) {
      const id = r.id as number
      let amount = r.refund_amount as number
      if (isLiveAmount({ reason: r.reason as string, status: r.status as string })) {
        const [live] = (await tx`
          SELECT balance FROM live_balances
           WHERE event = ${event} AND customer = ${who}
        `) as unknown as { balance: number }[]
        const claimed = await otherOpenClaims(tx, {
          id, event, customer: r.customer as string,
        })
        amount = Math.max(0, (live?.balance ?? 0) - claimed)
      }
      if (!(amount > 0)) {
        skipped.push({ id, reason: "Nothing is owed on it any more" })
        continue
      }

      const [payment] = (await tx`
        INSERT INTO payments (event, customer, amount, account, is_checked, remarks, kind, refund_id)
        VALUES (${event}, ${r.customer as string}, ${-amount}, ${account}, true,
                ${`Refund: ${r.reason as string}`}, 'refund', ${id})
        RETURNING id
      `) as unknown as { id: number }[]

      await tx`
        UPDATE refunds
           SET status = 'refunded',
               refund_amount = ${amount},
               transfer_reference = ${transferReference},
               bank_name = ${bankName},
               bank_account_number = ${bankAccountNumber},
               bank_account_holder = ${bankAccountHolder},
               payment_id = ${payment.id},
               updated_at = NOW()
         WHERE id = ${id}
      `
      paid.push({ id, amount })
    }

    return { paid, skipped, total: paid.reduce((n, p) => n + p.amount, 0) }
  })
}

/**
 * She said keep it: park the refund on her account as a deposit.
 *
 * The same state her own choice on the catalogue produces -- status
 * applied_to_next_order with the money still on the row and no payment written
 * -- reachable from the dashboard, because she is as likely to say it in a DM
 * as to press it. Without this the only honest thing to do was leave the refund
 * Pending, which reads as "we owe her and have not paid yet" and keeps
 * appearing on the Pending tab as work nobody is going to do.
 *
 * Deliberately names no target order: she may not have one yet, and which
 * future order it lands on is the shop's decision when that order exists.
 * applyRefundAsCredit is what actually moves it.
 *
 * The amount freezes here. A pending overpayment reads from her balance, and a
 * balance moves; a deposit is a fixed sum on her account, and the moment she
 * says "keep it" the money stops being a claim on that trip. Frozen at what is
 * owed right now -- the live figure, less what her other open refunds claim --
 * so the deposit banner offers exactly what she is owed rather than whatever
 * the row happened to be written with.
 */
export async function keepRefundOnAccount(refundId: number, actor?: string | null): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    const [refund] = await tx`SELECT * FROM refunds WHERE id = ${refundId} FOR UPDATE`
    if (!refund) throw new Error("Refund not found")
    if (refund.status === "refunded") throw new Error("This one has already been sent to her bank")
    if (refund.status === "cancelled") throw new Error("This refund was cancelled")
    if (refund.status === "applied_to_next_order") throw new Error("It is already on her account")

    let amount = refund.refund_amount as number
    if (isLiveAmount({ reason: refund.reason as string, status: refund.status as string })) {
      const [live] = (await tx`
        SELECT balance FROM live_balances
         WHERE event = ${refund.event as string}
           AND customer = lower(replace(${refund.customer as string}, '@', ''))
      `) as unknown as { balance: number }[]
      const claimed = await otherOpenClaims(tx, {
        id: refundId, event: refund.event as string, customer: refund.customer as string,
      })
      amount = Math.max(0, (live?.balance ?? 0) - claimed)
    }
    if (!(amount > 0)) throw new Error("There is nothing owed on this refund to keep")

    // Her bank details come off with it: they were collected to send money to,
    // and money is no longer being sent. Her own choice on the catalogue clears
    // them for the same reason.
    await tx`
      UPDATE refunds
         SET status = 'applied_to_next_order',
             refund_amount = ${amount},
             bank_name = '', bank_account_number = '', bank_account_holder = '',
             updated_at = NOW()
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
 * Partial-friendly: `amount` may be less than the overpayment. The refund row
 * tracks the REMAINING overpayment and stays `pending` until fully applied, at
 * which point it becomes `applied_to_next_order`.
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

    // What she is owed now, not what the row was written with. Moving a stale
    // figure onto another trip spends money that is no longer there, and the
    // credit payment makes it look deliberate afterwards.
    let remaining = refund.refund_amount as number
    if (isLiveAmount({ reason: refund.reason as string, status: refund.status as string })) {
      const [live] = (await tx`
        SELECT balance FROM live_balances
         WHERE event = ${refund.event as string}
           AND customer = lower(replace(${refund.customer as string}, '@', ''))
      `) as unknown as { balance: number }[]
      const claimed = await otherOpenClaims(tx, {
        id: refundId, event: refund.event as string, customer: refund.customer as string,
      })
      remaining = Math.max(0, (live?.balance ?? 0) - claimed)
    }
    if (!(remaining > 0)) throw new Error("Nothing left to apply")
    if (amount > remaining) throw new Error(`Amount exceeds the overpayment (Rp ${remaining})`)

    const sourceEvent = refund.event as string
    const reason = refund.reason as RefundReason
    const customer = normalizeCustomer(refund.customer as string)
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
    // Spending part of a deposit is not a change of mind about the rest. She
    // chose to keep the money on her account; taking Rp 1.000 of it to settle a
    // Rp 161.000 invoice leaves Rp 1.000 still hers, still a deposit.
    //
    // Dropping it back to "pending" is right for a refund that was only ever a
    // claim -- part paid, the remainder still queued -- but it hid the leftover
    // from the invoice banner and the list marker, which look for deposits. The
    // money the feature exists to surface would have gone quiet at exactly the
    // moment it got small enough to forget.
    const wasDeposit = refund.status === "applied_to_next_order"
    await tx`
      UPDATE refunds
      SET refund_amount = ${newRemaining},
          status = ${newRemaining <= 0 || wasDeposit ? "applied_to_next_order" : "pending"},
          note = ${newRemaining <= 0
            ? `Applied as credit to ${target}`
            : `Applied Rp ${amount} as credit to ${target}; Rp ${newRemaining} overpayment remaining`},
          updated_at = NOW()
      WHERE id = ${refundId}
    `
  })
}

/**
 * Reverse the credit transfer(s) this refund produced — e.g. applied to the
 * wrong order. Deletes exactly the linked `credit` payments (matched by
 * refund_id), restores the overpayment amount, and reopens it as `pending`.
 * Atomic. Does not touch a cash refund's `refund` payment.
 */
export async function undoRefundCredit(refundId: number, actor?: string | null): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    const [refund] = await tx`SELECT refund_amount FROM refunds WHERE id = ${refundId} FOR UPDATE`
    if (!refund) throw new Error("Refund not found")

    // The target (+) legs sum to how much was applied — that's what we restore.
    const [applied] = await tx`
      SELECT COALESCE(SUM(amount), 0)::int AS total
      FROM payments WHERE refund_id = ${refundId} AND kind = 'credit' AND amount > 0
    `
    if (!(applied.total > 0)) throw new Error("No applied credit to undo")

    await tx`DELETE FROM payments WHERE refund_id = ${refundId} AND kind = 'credit'`
    await tx`
      UPDATE refunds
      SET refund_amount = ${(refund.refund_amount as number) + (applied.total as number)},
          status = 'pending', note = '', updated_at = NOW()
      WHERE id = ${refundId}
    `
  })
}

/**
 * Keep existing overpayment refunds honest. Creates nothing.
 *
 * It used to insert, and wrote 224 of 232 live refunds — rows that were right
 * about the money and silent about the cause, and that nobody had asked for.
 * What it used to write is now the To-check list, where a person decides.
 *
 * Reconcile and cancel stay: those rows exist and must not drift. Both are
 * scoped to `reason = 'overpayment'` and to pristine rows, so a refund created
 * by a mark or by hand is never rewritten or retired here.
 *
 * Returns an empty array. The signature is unchanged so callers need not be.
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
    WITH order_aggregates AS (
      SELECT
        o.event,
        o.customer,
        SUM(o.unit_price * o.unit) AS subtotal,
        SUM(COALESCE(p.gram, 0) * o.unit) AS total_gram
      FROM orders o
      JOIN products p ON p.id = o.product_id
      GROUP BY o.event, o.customer
    ),
    payment_aggregates AS (
      SELECT event, customer, SUM(amount) AS total_paid
      FROM payments
      WHERE is_checked = true
      GROUP BY event, customer
    ),
    adjustment_aggregates AS (
      SELECT event, customer, SUM(amount) AS total_adj
      FROM adjustments
      GROUP BY event, customer
    ),
    -- Live per-(event, customer) invoice total, amount paid, and the resulting
    -- overpayment. Every branch below reads this one source of truth, so an
    -- insert, a reconcile, and a cancel can never disagree on the number.
    live AS (
      SELECT
        oa.event,
        oa.customer,
        (oa.subtotal
          + COALESCE(cwo.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
          + COALESCE(adj.total_adj, 0))::int AS invoice_total,
        COALESCE(pa.total_paid, 0)::int AS total_paid
      FROM order_aggregates oa
      LEFT JOIN customers c ON c.instagram_id = oa.customer
      -- Ongkir is the rate from the event's warehouse (per-event routing).
      LEFT JOIN events ev ON ev.name = oa.event
      LEFT JOIN customer_warehouse_ongkir cwo
        ON cwo.customer_id = c.id AND cwo.warehouse_id = ev.warehouse_id
      LEFT JOIN payment_aggregates pa ON pa.event = oa.event AND pa.customer = oa.customer
      LEFT JOIN adjustment_aggregates adj ON adj.event = oa.event AND adj.customer = oa.customer
    ),
    -- Reconcile still-open overpayment refunds to the live overpayment. Scope is
    -- deliberately narrow: only PRISTINE auto-detected rows — no linked payments,
    -- i.e. no credit applied and no transfer started. The moment a human moves
    -- money against a refund it is theirs to manage, so this background pass
    -- never rewrites it (see the NOT EXISTS guard). Data-modifying CTEs run even
    -- when the primary query doesn't reference them.
    -- Settled to what the OTHER live refunds leave uncovered, not to the whole
    -- overpayment. A mark's refund and this row would otherwise each claim the
    -- same money — 200,000 and 250,000 against a 250,000 debt. Mirrors
    -- residualExcluding in lib/db/refund-residual.ts; the two must agree.
    reconciled AS (
      UPDATE refunds r
      SET refund_amount = GREATEST(0, (l.total_paid - l.invoice_total) - COALESCE((
            SELECT SUM(o.refund_amount) FROM refunds o
             WHERE o.event = r.event
               AND lower(replace(o.customer, '@', '')) = lower(replace(r.customer, '@', ''))
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
               WHERE o.event = r.event
                 AND lower(replace(o.customer, '@', '')) = lower(replace(r.customer, '@', ''))
                 AND o.status <> 'cancelled' AND o.id <> r.id
            ), 0)) <> r.refund_amount
      RETURNING r.id
    ),
    -- Overpayment fully absorbed (live ≤ 0) → nothing left to refund, so drop it
    -- off the pipeline. Cancelling (not deleting) keeps history and lets a fresh
    -- refund re-materialize if the overpayment ever comes back. Same pristine-only
    -- guard: a refund with any linked payment (e.g. credit already applied) is
    -- left for a human, never auto-cancelled. Only pairs still in the live set are
    -- cancelled, so a pair whose orders were all deleted is left alone too.
    cancelled AS (
      UPDATE refunds r
      SET status = 'cancelled',
          note = 'Auto-cancelled: overpayment resolved',
          updated_at = NOW()
      FROM live l
      WHERE r.event = l.event AND r.customer = l.customer
        AND r.reason = 'overpayment'
        AND r.status IN ('pending', 'awaiting_bank_info', 'ready_to_refund')
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.refund_id = r.id)
        AND (l.total_paid - l.invoice_total) <= 0
      RETURNING r.id
    )
    -- Nothing is inserted. A brand-new overpayment is not a refund until a
    -- person says so — it appears in the To-check list instead
    -- (listOverpaymentsToCheck). The WITH chain still needs a final statement
    -- for the data-modifying CTEs above to run, and this one returns no rows.
    SELECT * FROM refunds WHERE false
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
  totalItems: number
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
                 SUM(o.unit) AS total_items,
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
          COALESCE(pa.total_paid, 0)::int AS total_paid,
          COALESCE(oa.total_items, 0)::int AS total_items
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
                 SUM(o.unit) AS total_items,
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
          COALESCE(pa.total_paid, 0)::int AS total_paid,
          COALESCE(oa.total_items, 0)::int AS total_items
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
      totalItems: Number(r.total_items),
      status: paymentStatusFor(totalPaid, invoiceTotal),
    }
  })
}

