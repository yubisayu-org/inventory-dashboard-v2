import sql from "../db-pool"
import { normalizeId, tsToString, normalizeCustomer } from "./helpers"
import { getInvoiceForCustomer } from "./invoice"
import type { PaymentRow, AdjustmentRow, RefundRow, RefundReason, RefundStatus } from "./types"

// ─── Payments ──────────────────────────────────────────────────────────────

export async function getPaymentRows(): Promise<PaymentRow[]> {
  const rows = await sql`
    SELECT id, event, customer, amount, account, is_checked,
           pay_date, remarks, created_at, updated_at
    FROM payments ORDER BY id DESC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    event: r.event,
    customer: r.customer,
    amount: r.amount ?? 0,
    account: r.account ?? "",
    isChecked: r.is_checked ?? false,
    payDate: r.pay_date ? new Date(r.pay_date).toISOString().slice(0, 10) : "",
    remarks: r.remarks ?? "",
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

export async function addPayment(data: {
  event: string
  customer: string
  amount: number
  account: string
  isChecked: boolean
  payDate: string
  remarks: string
}): Promise<{ rowNumber: number }> {
  const customer = normalizeCustomer(data.customer)
  await sql`
    INSERT INTO customers (instagram_id) VALUES (${customer})
    ON CONFLICT (instagram_id) DO NOTHING
  `
  const [row] = await sql`
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
): Promise<void> {
  const customer = normalizeCustomer(data.customer)
  await sql`
    INSERT INTO customers (instagram_id) VALUES (${customer})
    ON CONFLICT (instagram_id) DO NOTHING
  `
  await sql`
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
): Promise<void> {
  await sql`
    UPDATE payments SET is_checked = ${isChecked}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function updatePaymentRemarks(rowNumber: number, remarks: string): Promise<void> {
  await sql`
    UPDATE payments SET remarks = ${remarks}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function deletePayment(rowNumber: number): Promise<void> {
  await sql`DELETE FROM payments WHERE id = ${rowNumber}`
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
}): Promise<{ rowNumber: number }> {
  const customer = normalizeCustomer(data.customer)
  await sql`
    INSERT INTO customers (instagram_id) VALUES (${customer})
    ON CONFLICT (instagram_id) DO NOTHING
  `
  const [row] = await sql`
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
): Promise<void> {
  const customer = normalizeCustomer(data.customer)
  await sql`
    INSERT INTO customers (instagram_id) VALUES (${customer})
    ON CONFLICT (instagram_id) DO NOTHING
  `
  await sql`
    UPDATE adjustments
    SET event = ${data.event}, customer = ${customer},
        description = ${data.description}, amount = ${data.amount},
        updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function deleteAdjustment(rowNumber: number): Promise<void> {
  await sql`DELETE FROM adjustments WHERE id = ${rowNumber}`
}

// ─── Refunds ─────────────────────────────────────────────────────────────────

function mapRefundRow(r: Record<string, unknown>): RefundRow {
  return {
    id: r.id as number,
    event: r.event as string,
    customer: r.customer as string,
    reason: r.reason as RefundReason,
    refundAmount: r.refund_amount as number,
    status: r.status as RefundStatus,
    bankName: (r.bank_name as string) ?? "",
    bankAccountNumber: (r.bank_account_number as string) ?? "",
    bankAccountHolder: (r.bank_account_holder as string) ?? "",
    transferReference: (r.transfer_reference as string) ?? "",
    paymentId: (r.payment_id as number | null) ?? null,
    orderId: (r.order_id as number | null) ?? null,
    affectedUnits: (r.affected_units as number) ?? 0,
    note: (r.note as string) ?? "",
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
    `SELECT r.* FROM refunds r ${where} ORDER BY r.created_at DESC`,
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
}): Promise<RefundRow> {
  const customer = normalizeCustomer(data.customer)
  const [row] = await sql`
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
): Promise<void> {
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
  await sql.unsafe(
    `UPDATE refunds SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${params.length}`,
    params as (string | number)[],
  )
}

export async function executeRefund(
  refundId: number,
  transferReference: string,
): Promise<void> {
  const [refund] = await sql`SELECT * FROM refunds WHERE id = ${refundId}`
  if (!refund) throw new Error("Refund not found")
  if (refund.status === "refunded") throw new Error("Refund already executed")

  await sql.begin(async (tx) => {
    const [payment] = await tx`
      INSERT INTO payments (event, customer, amount, account, is_checked, remarks)
      VALUES (
        ${refund.event as string},
        ${refund.customer as string},
        ${-(refund.refund_amount as number)},
        ${refund.bank_account_number as string},
        true,
        ${`Refund: ${refund.reason}`}
      )
      RETURNING id
    `
    await tx`
      UPDATE refunds
      SET status             = 'refunded',
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

export async function deleteRefund(id: number): Promise<void> {
  await sql`DELETE FROM refunds WHERE id = ${id} AND status != 'refunded'`
}

/**
 * Auto-creates pending refund rows for every (event, customer) pair where
 * total checked payments exceed the invoice total, skipping pairs that
 * already have an active overpayment refund.
 *
 * Idempotent — safe to call on every refunds page load. Mirrors the invoice
 * math in getInvoiceForCustomer.
 *
 * Returns the rows that were just inserted (empty array if nothing to do).
 */
export async function materializeOverpaymentRefunds(): Promise<RefundRow[]> {
  const rows = await sql`
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
    candidates AS (
      SELECT
        oa.event,
        oa.customer,
        (oa.subtotal
          + COALESCE(c.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
          + COALESCE(adj.total_adj, 0))::int AS invoice_total,
        COALESCE(pa.total_paid, 0)::int AS total_paid
      FROM order_aggregates oa
      LEFT JOIN customers c ON c.instagram_id = oa.customer
      LEFT JOIN payment_aggregates pa ON pa.event = oa.event AND pa.customer = oa.customer
      LEFT JOIN adjustment_aggregates adj ON adj.event = oa.event AND adj.customer = oa.customer
      LEFT JOIN refunds r ON r.event = oa.event AND r.customer = oa.customer
        AND r.reason = 'overpayment' AND r.status != 'cancelled'
      WHERE r.id IS NULL
        AND COALESCE(pa.total_paid, 0) > (
          oa.subtotal
          + COALESCE(c.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
          + COALESCE(adj.total_adj, 0)
        )
    )
    INSERT INTO refunds (event, customer, reason, refund_amount, note)
    SELECT
      event,
      customer,
      'overpayment',
      total_paid - invoice_total,
      'Auto-detected: paid Rp ' || total_paid || ' of Rp ' || invoice_total
    FROM candidates
    RETURNING *
  `
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
  const rows = await sql`
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
      SELECT lower(replace(instagram_id, '@', '')) AS cust_key,
             MAX(COALESCE(ongkos_kirim, 0)) AS ongkos_kirim
      FROM customers
      GROUP BY lower(replace(instagram_id, '@', ''))
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
    LEFT JOIN customer_ongkir c ON c.cust_key = k.cust_key
    LEFT JOIN payment_aggregates pa ON pa.event = k.event AND pa.cust_key = k.cust_key
    LEFT JOIN adjustment_aggregates adj ON adj.event = k.event AND adj.cust_key = k.cust_key
    ORDER BY k.event, k.cust_key
  `

  const mapped = rows.map((r) => {
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
  // A specific event is the all-events result filtered down — identical rows to
  // the old per-event query.
  return event ? mapped.filter((r) => r.event === event) : mapped
}

