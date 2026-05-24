import sql from "../db-pool"
import { normalizeId } from "./helpers"
import { lookupCustomerDetail } from "./customers"
import type { InvoiceResult, InvoiceEvent, InvoiceShipment, InvoiceOrderLine, PublicInvoiceResult, PublicInvoiceEvent, PublicInvoiceOrderLine, CustomerDetail } from "./types"

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

// Porsager rows are string-indexed (any). These helpers read the order-row
// fields: event, unit, unit_price, unit_arrive, gram, event_eta.
type OrderRowLike = Record<string, any>

/** Group order rows by event, preserving first-seen order. */
function groupRowsByEvent<T extends OrderRowLike>(
  rows: readonly T[],
): { order: string[]; groups: Record<string, T[]> } {
  const groups: Record<string, T[]> = {}
  const order: string[] = []
  for (const row of rows) {
    const eid = String(row.event ?? "")
    if (!groups[eid]) {
      groups[eid] = []
      order.push(eid)
    }
    groups[eid].push(row)
  }
  return { order, groups }
}

/** Per-event totals + invoice math shared by the internal and public invoices. */
function computeEventCore(
  group: readonly OrderRowLike[],
  ongkirPerKg: number,
  pembayaran: number,
  biayaLainnya: number,
) {
  const unit = group.reduce((s, r) => s + Number(r.unit), 0)
  const subtotal = group.reduce((s, r) => s + Number(r.unit_price) * Number(r.unit), 0)
  const arrive = group.reduce((s, r) => s + Number(r.unit_arrive ?? 0), 0)
  const totalGram = group.reduce((s, r) => s + Number(r.gram ?? 0) * Number(r.unit), 0)
  const weightKg = Math.ceil(totalGram / 1000)
  const estimasiOngkir = ongkirPerKg * weightKg
  const total = subtotal + estimasiOngkir + biayaLainnya
  return {
    eta: String(group[0]?.event_eta ?? ""),
    totals: { unit, subtotal, arrive, weightKg },
    invoice: {
      subtotalBarang: subtotal,
      estimasiOngkir,
      ongkirPerKg,
      biayaLainnya,
      total,
      pembayaran,
      sisaPelunasan: total - pembayaran,
    },
  }
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

  const { order, groups } = groupRowsByEvent(orderRows)

  const events: InvoiceEvent[] = order.map((eid) => {
    const group = groups[eid]

    const orders: InvoiceOrderLine[] = group.map((r) => ({
      order: `${r.product_name} x ${r.unit}`,
      unit: r.unit,
      price: formatIdrNumber(r.unit_price),
      subtotal: formatIdrNumber(r.unit_price * r.unit),
      unitArrive: r.unit_arrive ?? 0,
      orderId: r.id as number,
      productName: r.product_name as string,
      rawUnitPrice: r.unit_price as number,
    }))

    const { eta, totals, invoice } = computeEventCore(
      group,
      ongkirPerKg,
      paymentByEvent.get(eid) ?? 0,
      adjustmentByEvent.get(eid) ?? 0,
    )

    const base = {
      eventId: eid,
      eta,
      status: "",
      shipments: [] as InvoiceShipment[],
      showShipments: false,
      orders,
      totals,
      invoice,
    }
    return { ...base, message: buildInvoiceMessage(base, customer) }
  })

  return { customer, customerDetail, events }
}

function formatShipDate(d: Date | string | null | undefined): string {
  if (!d) return ""
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })
}

/**
 * Derive the order status the recap page shows, from unit tracking + resi
 * presence. Mirrors the labels documented in the public site's status popup:
 *   Pending           — barang belum lengkap (not all units arrived)
 *   Processing        — barang sudah lengkap, antri packing (all arrived, none shipped)
 *   Partially Shipped — dikirim sebagian
 *   Shipped           — dikirim lengkap, menunggu resi (all shipped, no resi yet)
 *   Completed         — resi sudah dapat diakses (all shipped + resi present)
 */
function derivePublicStatus(group: readonly OrderRowLike[], hasResi: boolean): string {
  const totalUnit = group.reduce((s, r) => s + Number(r.unit), 0)
  if (totalUnit <= 0) return ""
  const totalArrive = group.reduce((s, r) => s + Number(r.unit_arrive ?? 0), 0)
  const totalShip = group.reduce((s, r) => s + Number(r.unit_ship ?? 0), 0)
  if (totalShip >= totalUnit) return hasResi ? "Completed" : "Shipped"
  if (totalShip > 0) return "Partially Shipped"
  if (totalArrive >= totalUnit) return "Processing"
  return "Pending"
}

/**
 * Public, no-login invoice lookup for the customer-facing recap site.
 *
 * Deliberately separate from getInvoiceForCustomer: it returns ONLY orders,
 * payment status, derived shipping status, and tracking numbers (what the
 * public page shows) and reads ONLY ongkos_kirim from customers — never name,
 * WhatsApp, data_diri, or bank details. Pass the read-only `invoice_reader`
 * connection (lib/db-public.ts) as `db` so the PII columns are physically
 * unreadable on this path. The seller's payment/bank block is a frontend
 * constant and is intentionally not returned here.
 */
export async function getPublicInvoiceForCustomer(
  instagramId: string,
  db: typeof sql,
): Promise<PublicInvoiceResult> {
  const searchId = normalizeId(instagramId)

  const [orderRows, ongkirRows, paymentRows, adjustmentRows, shipmentRows] = await Promise.all([
    db`
      SELECT o.event, o.customer, o.unit, o.unit_price, o.unit_arrive, o.unit_ship,
             p.name AS product_name, COALESCE(p.gram, 0) AS gram,
             COALESCE(e.eta, '') AS event_eta
      FROM orders o
      JOIN products p ON p.id = o.product_id
      LEFT JOIN events e ON e.name = o.event
      WHERE lower(replace(o.customer, '@', '')) = ${searchId}
      ORDER BY o.event, o.id
    `,
    db`
      SELECT ongkos_kirim
      FROM customers
      WHERE lower(replace(instagram_id, '@', '')) = ${searchId}
      LIMIT 1
    `,
    db`
      SELECT event, COALESCE(SUM(amount), 0) AS total_paid
      FROM payments
      WHERE lower(replace(customer, '@', '')) = ${searchId}
        AND is_checked = true
      GROUP BY event
    `,
    db`
      SELECT event, COALESCE(SUM(amount), 0) AS total_adj
      FROM adjustments
      WHERE lower(replace(customer, '@', '')) = ${searchId}
      GROUP BY event
    `,
    db`
      SELECT event, tracking_number, created_at
      FROM shipments
      WHERE lower(replace(customer, '@', '')) = ${searchId}
        AND tracking_number != ''
      ORDER BY event, id
    `,
  ])

  if (orderRows.length === 0) return { customer: "", events: [] }

  const customer = String(orderRows[0].customer ?? "")
  const ongkirPerKg = Number(ongkirRows[0]?.ongkos_kirim ?? 0)

  const paymentByEvent = new Map<string, number>()
  for (const r of paymentRows) paymentByEvent.set(r.event, Number(r.total_paid))

  const adjustmentByEvent = new Map<string, number>()
  for (const r of adjustmentRows) adjustmentByEvent.set(r.event, Number(r.total_adj))

  const shipmentsByEvent = new Map<string, InvoiceShipment[]>()
  for (const r of shipmentRows) {
    const list = shipmentsByEvent.get(r.event) ?? []
    list.push({ resi: cleanResi(String(r.tracking_number)), tanggalKirim: formatShipDate(r.created_at) })
    shipmentsByEvent.set(r.event, list)
  }

  const { order, groups } = groupRowsByEvent(orderRows)

  const events: PublicInvoiceEvent[] = order.map((eid) => {
    const group = groups[eid]

    const orders: PublicInvoiceOrderLine[] = group.map((r) => ({
      order: `${r.product_name} x ${r.unit}`,
      unit: r.unit,
      price: formatIdrNumber(r.unit_price),
      subtotal: formatIdrNumber(r.unit_price * r.unit),
      unitArrive: r.unit_arrive ?? 0,
    }))

    const { eta, totals, invoice } = computeEventCore(
      group,
      ongkirPerKg,
      paymentByEvent.get(eid) ?? 0,
      adjustmentByEvent.get(eid) ?? 0,
    )

    const shipments = shipmentsByEvent.get(eid) ?? []
    const status = derivePublicStatus(group, shipments.length > 0)
    const showShipments =
      shipments.length > 0 && (status === "Completed" || status.includes("Shipped"))

    return { eventId: eid, eta, status, shipments, showShipments, orders, totals, invoice }
  })

  return { customer, events }
}

