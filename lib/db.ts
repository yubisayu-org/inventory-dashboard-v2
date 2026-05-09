import sql from "./db-pool"

function normalizeId(id: string | null | undefined): string {
  return String(id ?? "").replace(/^@/, "").toLowerCase()
}

// ─── Types (same interfaces as the old sheets.ts) ───────────────────────────

export interface ItemOption {
  id: number
  name: string
  store: string
  price: number
}

export interface SheetOptions {
  events: string[]
  items: ItemOption[]
  customers: string[]
}

export interface OrderRow {
  event: string
  customer: string
  productId: number
  unitPrice: number
  unit: number
  note: string
}

export interface FormRow {
  rowNumber: number
  event: string
  customer: string
  productId: number
  items: string
  unitPrice: number
  unit: number
  note: string
  createdAt: string
  updatedAt: string
  unitBuy: number | null
  receipt: string
  unitArrive: number | null
  unitShip: number | null
  unitHold: number | null
}

export interface ExcessRow {
  rowNumber: number
  event: string
  items: string
  unitBuy: number
  receipt: string
  createdAt: string
  updatedAt: string
}

export interface PurchaseUpdate {
  rowNumber: number
  unitBuy: number
  receipt: string
}

export interface ArriveUpdate {
  rowNumber: number
  unitArrive: number
}

export interface InvoiceOrderLine {
  order: string
  unit: number
  price: string
  subtotal: string
  unitArrive: number
}

export interface InvoiceShipment {
  resi: string
  tanggalKirim: string
}

export interface InvoiceEvent {
  eventId: string
  eta: string
  status: string
  shipments: InvoiceShipment[]
  showShipments: boolean
  orders: InvoiceOrderLine[]
  totals: { unit: number; subtotal: number; arrive: number; weightKg: number }
  invoice: {
    subtotalBarang: number
    estimasiOngkir: number
    ongkirPerKg: number
    biayaLainnya: number
    total: number
    pembayaran: number
    sisaPelunasan: number
  }
  message: string
}

export interface ShipOrderLine {
  rowNumber: number
  event: string
  items: string
  productId: number
  productName: string
  gram: number
  unit: number
  unitArrive: number
  unitShip: number
  toShip: number
}

export interface CustomerDetail {
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  ongkosKirim: number
}

export interface ShipCustomer {
  customer: string
  event: string
  customerDetail: CustomerDetail | null
  orders: ShipOrderLine[]
  totalToShip: number
  weightKg: number
  ongkirPerKg: number
}

export interface InvoiceResult {
  customer: string
  customerDetail: CustomerDetail | null
  events: InvoiceEvent[]
}

export interface ShipOrdersParams {
  customer: string
  event: string
  orders: Array<{ rowNumber: number; productId: number; productName: string; toShip: number; unitShip: number }>
  weightKg: number
  ongkirPerKg: number
}

export interface ShippingRecord {
  rowNumber: number
  event: string
  customer: string
  shippingId: string
  invoicing: string
  weightEstimation: number
  ongkir: number
  ongkirTotal: number
  isLastShipment: boolean
  createdAt: string
  updatedAt: string
  trackingNumber: string
}

export interface ProductIndoRow {
  rowNumber: number
  product: string
  store: string
  price: number
}

export interface PaymentRow {
  rowNumber: number
  event: string
  customer: string
  amount: number
  account: string
  isChecked: boolean
  payDate: string
  remarks: string
  createdAt: string
  updatedAt: string
}

export interface AdjustmentRow {
  rowNumber: number
  event: string
  customer: string
  description: string
  amount: number
  createdAt: string
  updatedAt: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTimestamp(d: Date = new Date()): string {
  return d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function tsToString(v: Date | null | undefined): string {
  if (!v) return ""
  return formatTimestamp(v)
}

// ─── Options ────────────────────────────────────────────────────────────────

export async function getSheetOptions(): Promise<SheetOptions> {
  const [eventsRows, productRows, customerRows] = await Promise.all([
    sql`SELECT name FROM events ORDER BY name`,
    sql`SELECT id, name, store, price FROM products WHERE name != '' ORDER BY name`,
    sql`
      SELECT instagram_id FROM customers
      WHERE instagram_id NOT LIKE '\\_old%' AND instagram_id != 'gantialamat'
      ORDER BY instagram_id
    `,
  ])

  return {
    events: eventsRows.map((r) => r.name),
    items: productRows.map((r) => ({ id: r.id, name: r.name, store: r.store, price: r.price })),
    customers: customerRows.map((r) => r.instagram_id),
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
               o.unit_arrive, o.unit_ship, o.unit_hold
        FROM orders o
        JOIN products p ON p.id = o.product_id
        ORDER BY o.id DESC LIMIT ${limit}
      ) sub ORDER BY id ASC
    `
  } else {
    rows = await sql`
      SELECT o.id, o.event, o.customer, o.product_id, o.unit_price,
             p.name AS product_name, o.unit, o.note,
             o.created_at, o.updated_at, o.unit_buy, o.receipt,
             o.unit_arrive, o.unit_ship, o.unit_hold
      FROM orders o
      JOIN products p ON p.id = o.product_id
      ORDER BY o.id ASC
    `
  }

  return rows.map(mapFormRow)
}

export interface PaginatedFormRows {
  rows: FormRow[]
  totalCount: number
  page: number
  pageSize: number
  totalPages: number
}

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
}): Promise<PaginatedFormRows> {
  const { page, pageSize, search, event, customer, items, newestFirst } = opts
  const offset = (page - 1) * pageSize

  const conditions: string[] = []
  const params: (string | number)[] = []

  if (event) {
    params.push(event)
    conditions.push(`o.event = $${params.length}`)
  }
  if (customer) {
    params.push(customer)
    conditions.push(`o.customer = $${params.length}`)
  }
  if (items) {
    params.push(items)
    conditions.push(`p.name = $${params.length}`)
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

  const dataRows = await sql.unsafe(
    `SELECT o.id, o.event, o.customer, o.product_id, o.unit_price,
            p.name AS product_name, o.unit, o.note,
            o.created_at, o.updated_at, o.unit_buy, o.receipt,
            o.unit_arrive, o.unit_ship, o.unit_hold,
            COUNT(*) OVER() AS _total_count
     FROM orders o
     JOIN products p ON p.id = o.product_id
     ${where}
     ORDER BY ${sortCol} ${sortDir}, o.id ${sortDir}
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )

  const totalCount = dataRows.length > 0 ? Number(dataRows[0]._total_count) : 0
  return {
    rows: dataRows.map(mapFormRow),
    totalCount,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
  }
}

function mapFormRow(r: Record<string, unknown>): FormRow {
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
  }
}

/** Normalize customer handle to lowercase with @ prefix */
function normalizeCustomer(raw: string): string {
  const lower = raw.trim().toLowerCase()
  return lower.startsWith("@") ? lower : `@${lower}`
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

export async function deleteFormRow(rowNumber: number): Promise<void> {
  await sql`DELETE FROM orders WHERE id = ${rowNumber}`
}

// ─── Bulk updates ───────────────────────────────────────────────────────────

export async function bulkUpdatePurchase(updates: PurchaseUpdate[]): Promise<void> {
  if (updates.length === 0) return
  await sql.begin(async (tx) => {
    for (const u of updates) {
      await tx`
        UPDATE orders
        SET unit_buy = ${u.unitBuy}, receipt = ${u.receipt}, updated_at = NOW()
        WHERE id = ${u.rowNumber}
      `
    }
  })
}

export async function bulkUpdateArrive(updates: ArriveUpdate[]): Promise<void> {
  if (updates.length === 0) return
  await sql.begin(async (tx) => {
    for (const u of updates) {
      await tx`
        UPDATE orders SET unit_arrive = ${u.unitArrive}, updated_at = NOW()
        WHERE id = ${u.rowNumber}
      `
    }
  })
}

// ─── Excess Purchase ────────────────────────────────────────────────────────

export async function getExcessPurchaseRows(): Promise<ExcessRow[]> {
  const rows = await sql`
    SELECT id, event, items, unit_buy, receipt, created_at, updated_at
    FROM excess_purchase ORDER BY id ASC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    event: r.event,
    items: r.items,
    unitBuy: r.unit_buy,
    receipt: r.receipt ?? "",
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

export async function appendExcessPurchase(
  rows: { event: string; items: string; unitBuy: number; receipt: string }[],
): Promise<void> {
  if (rows.length === 0) return
  await sql`
    INSERT INTO excess_purchase ${sql(
      rows.map((r) => ({
        event: r.event,
        items: r.items,
        unit_buy: r.unitBuy,
        receipt: r.receipt,
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

// ─── Customers ──────────────────────────────────────────────────────────────

export async function lookupCustomerDetail(instagramId: string): Promise<CustomerDetail | null> {
  const searchId = normalizeId(instagramId)
  const rows = await sql`
    SELECT whatsapp, data_diri, ekspedisi, ongkos_kirim
    FROM customers
    WHERE lower(replace(instagram_id, '@', '')) = ${searchId}
    LIMIT 1
  `
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    whatsapp: r.whatsapp ?? "",
    dataDiri: r.data_diri ?? "",
    ekspedisi: r.ekspedisi ?? "",
    ongkosKirim: r.ongkos_kirim ?? 0,
  }
}

// ─── Invoice ────────────────────────────────────────────────────────────────

function formatIdrNumber(n: number | null | undefined): string {
  const v = Number(n)
  return new Intl.NumberFormat("id-ID").format(Number.isFinite(v) ? v : 0)
}

function buildInvoiceMessage(
  event: Omit<InvoiceEvent, "message">,
  customer: string,
): string {
  const { orders, totals, invoice } = event
  const handle = customer.startsWith("@") ? customer : `@${customer}`
  const produkLines = orders.map((o) => o.order).join("\n")

  const perKgCandidate = Number(invoice.ongkirPerKg)
  const perKg =
    Number.isFinite(perKgCandidate) && perKgCandidate > 0
      ? perKgCandidate
      : totals.weightKg > 0
        ? Math.round(invoice.estimasiOngkir / totals.weightKg)
        : 0

  const biayaLine = invoice.biayaLainnya !== 0
    ? [`Biaya Lainnya: Rp ${formatIdrNumber(invoice.biayaLainnya)}`]
    : []

  return [
    "INVOICE",
    `${event.eventId} ${handle}`,
    "",
    "Produk:",
    produkLines,
    "",
    `Subtotal Barang: Rp ${formatIdrNumber(invoice.subtotalBarang)}`,
    `Estimasi Ongkir: ${formatIdrNumber(totals.weightKg)} kg x Rp ${formatIdrNumber(perKg)}`,
    ...biayaLine,
    "",
    `Pelunasan: Rp ${formatIdrNumber(invoice.sisaPelunasan)}`,
    "",
    "Rekening an Shinta Michiko:",
    "Bank Jago (Artos) 103382719370",
    "Bank Central Asia 4419051991 ",
    "",
    "Apabila memesan lebih dari 1 barang, transfer boleh digabung.",
    "",
    "Cek rekapan mandiri https://yubisayu-invoice.netlify.app/",
    "",
    "Jika ada kesalahan/kekurangan rekap, mohon infokan kembali untuk direvisi.",
  ].join("\n")
}

function cleanResi(s: string): string {
  return s.trim().replace(/^['‘’ʹ`]+/, "")
}

function parseShipments(
  resiRaw: string,
  tanggalRaw: string,
  status: string,
): { shipments: InvoiceShipment[]; showShipments: boolean } {
  const resiList = resiRaw ? resiRaw.split("\n").map(cleanResi).filter(Boolean) : []
  const tanggalList = tanggalRaw
    ? tanggalRaw.split("\n").map((s) => s.trim()).filter(Boolean)
    : []
  const shipments = resiList.map((resi, i) => ({ resi, tanggalKirim: tanggalList[i] || "" }))
  const showShipments =
    shipments.length > 0 && (status === "Completed" || status.includes("Shipped"))
  return { shipments, showShipments }
}

/**
 * Invoice data is computed by joining orders + products + customers.
 *
 * The old Google Sheets "Order_JanganDisort_DifilterAja" tab had ~31 columns
 * with many formulas. In SQL, we derive the same data from the orders table
 * joined with products (for price/weight) and customers (for ongkir rate).
 *
 * Columns that were manually entered in the invoice sheet (ETA, Status,
 * Pembayaran, BiayaLainnya, etc.) are NOT yet migrated — those would need
 * a dedicated `invoice_events` table. For now we return empty defaults for
 * those fields, matching what a fresh start provides.
 */
export async function getInvoiceForCustomer(instagramId: string): Promise<InvoiceResult> {
  const searchId = normalizeId(instagramId)

  const [orderRows, customerDetail, paymentRows, adjustmentRows] = await Promise.all([
    sql`
      SELECT o.id, o.event, o.customer, o.unit, o.note,
             o.unit_price, o.product_id,
             o.unit_buy, o.receipt, o.unit_arrive, o.unit_ship, o.unit_hold,
             p.name AS product_name, COALESCE(p.store, '') AS store,
             COALESCE(p.gram, 0) AS gram,
             COALESCE(e.eta, '') AS event_eta
      FROM orders o
      JOIN products p ON p.id = o.product_id
      LEFT JOIN events e ON e.name = o.event
      WHERE lower(replace(o.customer, '@', '')) = ${searchId}
      ORDER BY o.event, o.id
    `,
    lookupCustomerDetail(instagramId),
    sql`
      SELECT event, COALESCE(SUM(amount), 0) AS total_paid
      FROM payments
      WHERE lower(replace(customer, '@', '')) = ${searchId}
        AND is_checked = true
      GROUP BY event
    `,
    sql`
      SELECT event, COALESCE(SUM(amount), 0) AS total_adj
      FROM adjustments
      WHERE lower(replace(customer, '@', '')) = ${searchId}
      GROUP BY event
    `,
  ])

  if (orderRows.length === 0) {
    return { customer: "", customerDetail, events: [] }
  }

  const customer = orderRows[0].customer
  const ongkirPerKg = customerDetail?.ongkosKirim ?? 0

  const paymentByEvent = new Map<string, number>()
  for (const r of paymentRows) paymentByEvent.set(r.event, Number(r.total_paid))

  const adjustmentByEvent = new Map<string, number>()
  for (const r of adjustmentRows) adjustmentByEvent.set(r.event, Number(r.total_adj))

  type OrderQueryRow = (typeof orderRows)[number]
  const groups: Record<string, OrderQueryRow[]> = {}
  const order: string[] = []
  for (const row of orderRows) {
    const eid = row.event || ""
    if (!groups[eid]) {
      groups[eid] = []
      order.push(eid)
    }
    groups[eid].push(row)
  }

  const events: InvoiceEvent[] = order.map((eid) => {
    const group = groups[eid]

    const orders: InvoiceOrderLine[] = group.map((r) => ({
      order: `${r.product_name} x ${r.unit}`,
      unit: r.unit,
      price: formatIdrNumber(r.unit_price),
      subtotal: formatIdrNumber(r.unit_price * r.unit),
      unitArrive: r.unit_arrive ?? 0,
    }))

    const totalUnit = orders.reduce((s, o) => s + o.unit, 0)
    const totalSubtotal = group.reduce((s, r) => s + r.unit_price * r.unit, 0)
    const totalArrive = orders.reduce((s, o) => s + o.unitArrive, 0)
    const totalGram = group.reduce((s, r) => s + (r.gram ?? 0) * r.unit, 0)
    const weightKg = Math.ceil(totalGram / 1000)
    const estimasiOngkir = ongkirPerKg * weightKg

    const eta = group[0]?.event_eta ?? ""

    const base = {
      eventId: eid,
      eta,
      status: "",
      shipments: [] as InvoiceShipment[],
      showShipments: false,
      orders,
      totals: { unit: totalUnit, subtotal: totalSubtotal, arrive: totalArrive, weightKg },
      invoice: (() => {
        const biayaLainnya = adjustmentByEvent.get(eid) ?? 0
        const total = totalSubtotal + estimasiOngkir + biayaLainnya
        const pembayaran = paymentByEvent.get(eid) ?? 0
        return {
          subtotalBarang: totalSubtotal,
          estimasiOngkir,
          ongkirPerKg,
          biayaLainnya,
          total,
          pembayaran,
          sisaPelunasan: total - pembayaran,
        }
      })(),
    }
    return { ...base, message: buildInvoiceMessage(base, customer) }
  })

  return { customer, customerDetail, events }
}

// ─── Ship Orders ────────────────────────────────────────────────────────────

function buildSearchFilters(opts: { event?: string; search?: string }) {
  const conditions: string[] = []
  const params: (string | number)[] = []
  if (opts.event) {
    params.push(opts.event)
    conditions.push(`o.event = $${params.length}`)
  }
  if (opts.search) {
    params.push(`%${normalizeId(opts.search)}%`)
    conditions.push(`lower(replace(o.customer, '@', '')) LIKE $${params.length}`)
  }
  return { conditions, params }
}

function buildShipGroups(
  orderRows: Record<string, unknown>[],
  detailMap: Map<string, CustomerDetail>,
): ShipCustomer[] {
  const groupMap = new Map<string, { customer: string; event: string; rows: Record<string, unknown>[] }>()
  for (const row of orderRows) {
    const key = `${normalizeId(row.customer as string)}|${row.event}`
    if (!groupMap.has(key)) groupMap.set(key, { customer: row.customer as string, event: row.event as string, rows: [] })
    groupMap.get(key)!.rows.push(row)
  }

  return Array.from(groupMap.values()).map(({ customer, event, rows }) => {
    const customerKey = normalizeId(customer)
    const orders: ShipOrderLine[] = rows.map((r) => {
      const unitArrive = (r.unit_arrive as number) ?? 0
      const unitShip = (r.unit_ship as number) ?? 0
      return {
        rowNumber: r.id as number,
        event,
        items: `${r.product_name} x ${r.unit}`,
        productId: r.product_id as number,
        productName: r.product_name as string,
        gram: (r.gram as number) ?? 0,
        unit: r.unit as number,
        unitArrive,
        unitShip,
        toShip: Math.max(0, unitArrive - unitShip),
      }
    })
    const totalToShipGram = orders.reduce((s, o) => s + o.gram * o.toShip, 0)
    const ongkirPerKg = detailMap.get(customerKey)?.ongkosKirim ?? 0
    return {
      customer,
      event,
      customerDetail: detailMap.get(customerKey) ?? null,
      orders,
      totalToShip: orders.reduce((s, o) => s + o.toShip, 0),
      weightKg: totalToShipGram / 1000,
      ongkirPerKg,
    }
  })
}

async function fetchCustomerDetails(customerIds: Set<string>): Promise<Map<string, CustomerDetail>> {
  const detailMap = new Map<string, CustomerDetail>()
  if (customerIds.size === 0) return detailMap
  const rows = await sql`
    SELECT instagram_id, whatsapp, data_diri, ekspedisi, ongkos_kirim
    FROM customers
    WHERE lower(replace(instagram_id, '@', '')) = ANY(${[...customerIds]})
  `
  for (const r of rows) {
    const id = normalizeId(r.instagram_id)
    if (id) {
      detailMap.set(id, {
        whatsapp: r.whatsapp ?? "",
        dataDiri: r.data_diri ?? "",
        ekspedisi: r.ekspedisi ?? "",
        ongkosKirim: r.ongkos_kirim ?? 0,
      })
    }
  }
  return detailMap
}

export type ShipSegment = "all" | "not_arrived" | "ready" | "shipped"

export interface ShipOrdersFiltered {
  groups: ShipCustomer[]
  totalCount: number
  counts: Record<ShipSegment, number>
}

export async function getShipOrdersFiltered(opts: {
  segment?: ShipSegment
  search?: string
  event?: string
}): Promise<ShipOrdersFiltered> {
  const { segment = "all", search, event } = opts

  const { conditions, params } = buildSearchFilters({ event, search })

  if (segment === "not_arrived") {
    conditions.push("(o.unit_arrive IS NULL OR o.unit_arrive = 0)")
  } else if (segment !== "all") {
    conditions.push("o.unit_arrive IS NOT NULL AND o.unit_arrive > 0")
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const { conditions: countConds, params: countParams } = buildSearchFilters({ event, search })
  const countWhere = countConds.length > 0 ? `WHERE ${countConds.join(" AND ")}` : ""

  const [orderRows, countRows] = await Promise.all([
    sql.unsafe(
      `SELECT o.id, o.event, o.customer, o.product_id, p.name AS product_name,
              COALESCE(p.gram, 0) AS gram, o.unit, o.unit_arrive, o.unit_ship
       FROM orders o
       JOIN products p ON p.id = o.product_id
       ${where}
       ORDER BY o.event, o.customer, o.id`,
      params,
    ),
    sql.unsafe(
      `SELECT
         o.customer, o.event,
         bool_and(COALESCE(o.unit_arrive, 0) = 0) AS all_not_arrived,
         COALESCE(SUM(GREATEST(0, COALESCE(o.unit_arrive, 0) - COALESCE(o.unit_ship, 0))), 0) AS total_to_ship
       FROM orders o ${countWhere}
       GROUP BY o.customer, o.event`,
      countParams,
    ),
  ])

  const customerIds = new Set<string>()
  for (const r of orderRows) customerIds.add(normalizeId(r.customer))

  const detailMap = await fetchCustomerDetails(customerIds)
  const allGroups = buildShipGroups(orderRows, detailMap)

  const filteredGroups = segment === "ready"
    ? allGroups.filter((g) => g.totalToShip > 0)
    : segment === "shipped"
      ? allGroups.filter((g) => g.totalToShip === 0)
      : allGroups

  let notArrivedCount = 0
  let readyCount = 0
  let shippedCount = 0
  for (const r of countRows) {
    if (r.all_not_arrived) notArrivedCount++
    else if (Number(r.total_to_ship) > 0) readyCount++
    else shippedCount++
  }

  return {
    groups: filteredGroups,
    totalCount: filteredGroups.length,
    counts: {
      all: notArrivedCount + readyCount + shippedCount,
      not_arrived: notArrivedCount,
      ready: readyCount,
      shipped: shippedCount,
    },
  }
}

export async function shipCustomerOrders(params: ShipOrdersParams): Promise<{ shippingId: string }> {
  const { customer, event, orders, weightKg, ongkirPerKg } = params

  return await sql.begin(async (tx) => {
    const [maxRow] = await tx`
      SELECT COALESCE(MAX(shipping_id::integer), 0) AS max_id FROM shipments
    `
    const shippingId = String((maxRow.max_id ?? 0) + 1).padStart(4, "0")

    const toShipRows = orders.filter((o) => o.toShip > 0)
    const invoicingText = toShipRows.map((o) => `${o.productName} x ${o.toShip}`).join("\n")
    const ongkirTotal = ongkirPerKg * weightKg

    await tx`
      INSERT INTO shipments (event, customer, shipping_id, invoicing, weight_estimation, ongkir, ongkir_total, is_last_shipment)
      VALUES (${event}, ${customer}, ${shippingId}, ${invoicingText}, ${weightKg}, ${ongkirPerKg}, ${ongkirTotal}, true)
    `

    for (const order of toShipRows) {
      await tx`
        UPDATE orders
        SET unit_ship = COALESCE(unit_ship, 0) + ${order.toShip}, updated_at = NOW()
        WHERE id = ${order.rowNumber}
      `
    }

    return { shippingId }
  })
}

// ─── Shipments ──────────────────────────────────────────────────────────────

export async function getShippingRecords(): Promise<ShippingRecord[]> {
  const rows = await sql`
    SELECT id, event, customer, shipping_id, invoicing,
           weight_estimation, ongkir, ongkir_total, is_last_shipment,
           created_at, updated_at, tracking_number
    FROM shipments
    WHERE shipping_id != ''
    ORDER BY id ASC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    event: r.event,
    customer: r.customer,
    shippingId: String(r.shipping_id).padStart(4, "0"),
    invoicing: r.invoicing ?? "",
    weightEstimation: Number(r.weight_estimation) || 0,
    ongkir: r.ongkir ?? 0,
    ongkirTotal: r.ongkir_total ?? 0,
    isLastShipment: r.is_last_shipment ?? false,
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
    trackingNumber: r.tracking_number ?? "",
  }))
}

export async function updateTrackingNumber(
  rowNumber: number,
  trackingNumber: string,
): Promise<void> {
  await sql`
    UPDATE shipments
    SET tracking_number = ${trackingNumber}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

// ─── Products Indo ──────────────────────────────────────────────────────────

export async function getProductIndo(): Promise<ProductIndoRow[]> {
  const rows = await sql`
    SELECT id, product, store, price FROM products_indo
    WHERE product != '' ORDER BY id ASC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    product: r.product,
    store: r.store,
    price: r.price ?? 0,
  }))
}

export async function addProductIndo(data: {
  product: string
  store: string
  price: number
}): Promise<{ rowNumber: number }> {
  const [row] = await sql`
    INSERT INTO products_indo (product, store, price)
    VALUES (${data.product}, ${data.store}, ${data.price})
    RETURNING id
  `
  return { rowNumber: row.id }
}

export async function updateProductIndo(
  rowNumber: number,
  data: { product: string; store: string; price: number },
): Promise<void> {
  await sql`
    UPDATE products_indo
    SET product = ${data.product}, store = ${data.store}, price = ${data.price}
    WHERE id = ${rowNumber}
  `
}

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

export async function togglePaymentChecked(
  rowNumber: number,
  isChecked: boolean,
): Promise<void> {
  await sql`
    UPDATE payments SET is_checked = ${isChecked}, updated_at = NOW()
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
