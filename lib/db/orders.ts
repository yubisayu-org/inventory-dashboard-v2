import sql from "../db-pool"
import { tsToString, normalizeCustomer } from "./helpers"
import type { SheetOptions, ItemOption, OrderRow, FormRow, ExcessRow, ExcessReason, PurchaseUpdate, ArriveUpdate } from "./types"

// ─── Options ────────────────────────────────────────────────────────────────

export async function getSheetOptions(): Promise<SheetOptions> {
  const [eventsRows, productRows, customerRows] = await Promise.all([
    sql`SELECT name FROM events ORDER BY created_at DESC, id DESC`,
    sql`SELECT id, name, store, price FROM products WHERE name != '' ORDER BY name`,
    sql`
      SELECT instagram_id FROM customers
      WHERE instagram_id NOT LIKE '\\_old%' AND instagram_id != 'gantialamat'
      ORDER BY instagram_id
    `,
  ])

  // Collapse handles that differ only by a leading "@" or case (legacy Sheets
  // imports stored e.g. "shinta.michiko" while app writes store "@shinta.michiko")
  // into a single canonical entry, so the picker shows each customer once.
  // The customers table is left untouched — this only de-dupes the options list.
  const customers = [
    ...new Set(customerRows.map((r) => normalizeCustomer(r.instagram_id))),
  ].sort()

  return {
    events: eventsRows.map((r) => r.name),
    items: productRows.map((r) => ({ id: r.id, name: r.name, store: r.store, price: r.price })),
    customers,
  }
}

// ─── Orders (Duplicate_Form) ────────────────────────────────────────────────

export async function getDuplicateFormRows(limit?: number): Promise<FormRow[]> {
  let rows
  if (limit && limit > 0) {
    rows = await sql`
      SELECT * FROM (
        SELECT o.id, o.event, o.customer, o.product_id, o.unit_price,
               p.name AS product_name, o.unit, o.note,
               o.created_at, o.updated_at, o.unit_buy, o.receipt,
               o.unit_arrive, o.unit_ship, o.unit_hold,
               c.data_diri AS customer_data_diri
        FROM orders o
        JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c
          ON lower(replace(c.instagram_id, '@', '')) = lower(replace(o.customer, '@', ''))
        ORDER BY o.id DESC LIMIT ${limit}
      ) sub ORDER BY id ASC
    `
  } else {
    rows = await sql`
      SELECT o.id, o.event, o.customer, o.product_id, o.unit_price,
             p.name AS product_name, o.unit, o.note,
             o.created_at, o.updated_at, o.unit_buy, o.receipt,
             o.unit_arrive, o.unit_ship, o.unit_hold,
             c.data_diri AS customer_data_diri
      FROM orders o
      JOIN products p ON p.id = o.product_id
      LEFT JOIN customers c
        ON lower(replace(c.instagram_id, '@', '')) = lower(replace(o.customer, '@', ''))
      ORDER BY o.id ASC
    `
  }

  return rows.map(mapFormRow)
}

/**
 * Returns every order for a single event, ordered chronologically (id ASC).
 * Used by FIFO allocators in /api/sheets/arrive and /api/sheets/purchasing —
 * each route applies its own per-row eligibility filter on top.
 *
 * The win over `getDuplicateFormRows()` is scoping the read to one event so
 * we don't transfer the entire orders table across the wire each time.
 */
export async function getDuplicateFormRowsForEvent(event: string): Promise<FormRow[]> {
  const rows = await sql`
    SELECT o.id, o.event, o.customer, o.product_id, o.unit_price,
           p.name AS product_name, o.unit, o.note,
           o.created_at, o.updated_at, o.unit_buy, o.receipt,
           o.unit_arrive, o.unit_ship, o.unit_hold,
           c.data_diri AS customer_data_diri
    FROM orders o
    JOIN products p ON p.id = o.product_id
    LEFT JOIN customers c
      ON lower(replace(c.instagram_id, '@', '')) = lower(replace(o.customer, '@', ''))
    WHERE o.event = ${event}
    ORDER BY o.id ASC
  `
  return rows.map(mapFormRow)
}

export interface PaginatedFormRows {
  rows: FormRow[]
  totalCount: number
  page: number
  pageSize: number
  totalPages: number
}

/**
 * Sentinel value for {@link PaginatedFormRows.totalCount} when the caller
 * passed `skipCount: true`. Means "I already have the total from a prior
 * request with the same filters/search/sort — don't trust this field, reuse
 * your cached value." Avoids the O(N) `COUNT(*)` work when the user is just
 * paging through results without changing what's being counted.
 */
export const TOTAL_COUNT_UNCHANGED = -1

export async function getDuplicateFormRowsPaginated(opts: {
  page: number
  pageSize: number
  search?: string
  event?: string
  customer?: string
  items?: string
  sortKey?: string
  sortDir?: "asc" | "desc"
  newestFirst?: boolean
  /**
   * When true, skip the COUNT(*) query and return TOTAL_COUNT_UNCHANGED for
   * totalCount / totalPages. The caller is responsible for reusing the
   * previously cached count. Set this when only the page changed within an
   * otherwise identical query — the count cannot have changed.
   */
  skipCount?: boolean
}): Promise<PaginatedFormRows> {
  const { page, pageSize, search, event, customer, items, newestFirst, skipCount } = opts
  const offset = (page - 1) * pageSize

  const conditions: string[] = []
  const params: (string | number)[] = []

  // Column filters are "contains" in the UI (and on every client-side page),
  // so match them case-insensitively as substrings — not exact equality.
  if (event) {
    params.push(`%${event.toLowerCase()}%`)
    conditions.push(`lower(o.event) LIKE $${params.length}`)
  }
  if (customer) {
    params.push(`%${customer.toLowerCase()}%`)
    conditions.push(`lower(o.customer) LIKE $${params.length}`)
  }
  if (items) {
    params.push(`%${items.toLowerCase()}%`)
    conditions.push(`lower(p.name) LIKE $${params.length}`)
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`)
    const p = `$${params.length}`
    conditions.push(`(lower(o.event) LIKE ${p} OR lower(o.customer) LIKE ${p} OR lower(p.name) LIKE ${p} OR lower(o.note) LIKE ${p} OR CAST(o.unit AS TEXT) LIKE ${p})`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const SORT_COLUMNS: Record<string, string> = {
    event: "o.event", customer: "o.customer", items: "p.name",
    unit: "o.unit", note: "o.note", createdAt: "o.created_at",
    unitBuy: "o.unit_buy", receipt: "o.receipt",
    unitArrive: "o.unit_arrive", unitShip: "o.unit_ship", unitHold: "o.unit_hold",
    updatedAt: "o.updated_at",
  }
  const sortCol = (opts.sortKey && SORT_COLUMNS[opts.sortKey]) || "o.id"
  const sortDir = opts.sortDir === "desc" || (!opts.sortKey && newestFirst) ? "DESC" : "ASC"

  // Rows query: LIMIT/OFFSET means this is bounded work even on a big table.
  // The customers LEFT JOIN is here (not in the count) because hasAddress is
  // read off it for each rendered row.
  const dataQuery = sql.unsafe(
    `SELECT o.id, o.event, o.customer, o.product_id, o.unit_price,
            p.name AS product_name, o.unit, o.note,
            o.created_at, o.updated_at, o.unit_buy, o.receipt,
            o.unit_arrive, o.unit_ship, o.unit_hold,
            c.data_diri AS customer_data_diri
     FROM orders o
     JOIN products p ON p.id = o.product_id
     LEFT JOIN customers c
       ON lower(replace(c.instagram_id, '@', '')) = lower(replace(o.customer, '@', ''))
     ${where}
     ORDER BY ${sortCol} ${sortDir}, o.id ${sortDir}
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )

  if (skipCount) {
    const dataRows = await dataQuery
    return {
      rows: dataRows.map(mapFormRow),
      totalCount: TOTAL_COUNT_UNCHANGED,
      page,
      pageSize,
      totalPages: TOTAL_COUNT_UNCHANGED,
    }
  }

  // Count query: mirrors the rows query's WHERE but omits the customers join
  // (LEFT JOIN can't change row count) so the planner has less to do.
  const countQuery = sql.unsafe(
    `SELECT COUNT(*)::int AS c
     FROM orders o
     JOIN products p ON p.id = o.product_id
     ${where}`,
    params,
  )

  const [dataRows, countRows] = await Promise.all([dataQuery, countQuery])
  const totalCount = Number(countRows[0]?.c ?? 0)
  return {
    rows: dataRows.map(mapFormRow),
    totalCount,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
  }
}

function mapFormRow(r: Record<string, unknown>): FormRow {
  // NULL means the customer row doesn't exist (yet); treat as no address.
  const dataDiri = (r.customer_data_diri as string | null) ?? ""
  return {
    rowNumber: r.id as number,
    event: r.event as string,
    customer: r.customer as string,
    productId: r.product_id as number,
    items: r.product_name as string,
    unitPrice: r.unit_price as number,
    unit: r.unit as number,
    note: r.note as string,
    createdAt: tsToString(r.created_at as Date | null),
    updatedAt: tsToString(r.updated_at as Date | null),
    unitBuy: (r.unit_buy as number) ?? null,
    receipt: (r.receipt as string) ?? "",
    unitArrive: (r.unit_arrive as number) ?? null,
    unitShip: (r.unit_ship as number) ?? null,
    unitHold: (r.unit_hold as number) ?? null,
    hasAddress: dataDiri.trim().length > 0,
  }
}

export async function appendOrders(orders: OrderRow[]): Promise<void> {
  if (orders.length === 0) return

  const normalized = orders.map((o) => ({
    ...o,
    customer: normalizeCustomer(o.customer),
  }))

  // Auto-create customer records for any new customers
  const uniqueCustomers = [...new Set(normalized.map((o) => o.customer))]
  await sql`
    INSERT INTO customers (instagram_id)
    VALUES ${sql(uniqueCustomers.map((c) => [c]))}
    ON CONFLICT (instagram_id) DO NOTHING
  `

  await sql`
    INSERT INTO orders ${sql(
      normalized.map((o) => ({
        event: o.event,
        customer: o.customer,
        product_id: o.productId,
        unit_price: o.unitPrice,
        unit: o.unit,
        note: o.note,
      }))
    )}
  `
}

export async function updateFormRow(
  rowNumber: number,
  data: Pick<FormRow, "event" | "customer" | "productId" | "unitPrice" | "unit" | "note">,
): Promise<void> {
  const customer = normalizeCustomer(data.customer)
  // Auto-create customer record if it doesn't exist
  await sql`
    INSERT INTO customers (instagram_id) VALUES (${customer})
    ON CONFLICT (instagram_id) DO NOTHING
  `
  await sql`
    UPDATE orders
    SET event = ${data.event}, customer = ${customer}, product_id = ${data.productId},
        unit_price = ${data.unitPrice}, unit = ${data.unit}, note = ${data.note},
        updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function updateFormRowStage2(
  rowNumber: number,
  data: { unitBuy: number; receipt: string },
): Promise<void> {
  await sql`
    UPDATE orders
    SET unit_buy = ${data.unitBuy}, receipt = ${data.receipt}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function updateFormRowStage3(
  rowNumber: number,
  data: { unitArrive: number; unitShip: number; unitHold: number },
): Promise<void> {
  await sql`
    UPDATE orders
    SET unit_arrive = ${data.unitArrive}, unit_ship = ${data.unitShip},
        unit_hold = ${data.unitHold}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

/**
 * Owner-only manual correction of unit_arrive and unit_hold on a single order
 * row, used by the List Order edit modal. Kept separate from Stage 3 so the
 * arrival/ship flow contract (which writes all three quantity columns at once)
 * isn't entangled with one-off manual fixes.
 */
export async function updateFormRowOwnerQty(
  rowNumber: number,
  data: { unitArrive: number | null; unitHold: number | null },
): Promise<void> {
  await sql`
    UPDATE orders
    SET unit_arrive = ${data.unitArrive},
        unit_hold = ${data.unitHold},
        updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function deleteFormRow(rowNumber: number): Promise<void> {
  await sql`DELETE FROM orders WHERE id = ${rowNumber}`
}

// ─── Bulk updates ───────────────────────────────────────────────────────────

export async function bulkUpdatePurchase(updates: PurchaseUpdate[]): Promise<void> {
  if (updates.length === 0) return
  const ids = updates.map((u) => u.rowNumber)
  const unitBuys = updates.map((u) => u.unitBuy)
  const receipts = updates.map((u) => u.receipt)
  await sql`
    UPDATE orders SET
      unit_buy = data.unit_buy,
      receipt = data.receipt,
      updated_at = NOW()
    FROM unnest(${ids}::int[], ${unitBuys}::int[], ${receipts}::text[])
      AS data(id, unit_buy, receipt)
    WHERE orders.id = data.id
  `
}

export async function bulkUpdateArrive(updates: ArriveUpdate[]): Promise<void> {
  if (updates.length === 0) return
  const ids = updates.map((u) => u.rowNumber)
  const arrives = updates.map((u) => u.unitArrive)
  await sql`
    UPDATE orders SET
      unit_arrive = data.unit_arrive,
      updated_at = NOW()
    FROM unnest(${ids}::int[], ${arrives}::int[])
      AS data(id, unit_arrive)
    WHERE orders.id = data.id
  `
}

// ─── Excess Purchase ────────────────────────────────────────────────────────

export async function getExcessPurchaseRows(): Promise<ExcessRow[]> {
  const rows = await sql`
    SELECT id, event, items, unit_buy, receipt, reason, expected_item, created_at, updated_at
    FROM excess_purchase ORDER BY id ASC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    event: r.event,
    items: r.items,
    unitBuy: r.unit_buy,
    receipt: r.receipt ?? "",
    reason: (r.reason ?? "overbuy") as ExcessReason,
    expectedItem: r.expected_item ?? "",
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

export async function appendExcessPurchase(
  rows: {
    event: string
    items: string
    unitBuy: number
    receipt: string
    reason?: ExcessReason
    expectedItem?: string
  }[],
): Promise<void> {
  if (rows.length === 0) return
  await sql`
    INSERT INTO excess_purchase ${sql(
      rows.map((r) => ({
        event: r.event,
        items: r.items,
        unit_buy: r.unitBuy,
        receipt: r.receipt,
        reason: r.reason ?? "overbuy",
        expected_item: r.expectedItem ?? null,
      }))
    )}
  `
}

export async function updateExcessRowUnitBuy(rowNumber: number, unitBuy: number): Promise<void> {
  await sql`
    UPDATE excess_purchase SET unit_buy = ${unitBuy}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function deleteExcessRow(rowNumber: number): Promise<void> {
  await sql`DELETE FROM excess_purchase WHERE id = ${rowNumber}`
}

