// Shared types for the db/* modules.

import type { PaymentStatus } from "./finance"

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

export type ExcessReason = "overbuy" | "overship" | "wrong_product"

export interface ExcessRow {
  rowNumber: number
  event: string
  items: string
  unitBuy: number
  receipt: string
  reason: ExcessReason
  expectedItem: string
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
  // Raw fields for pre-filling the refund modal
  orderId: number
  productName: string
  rawUnitPrice: number
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
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
}

export interface CustomerRow {
  id: number
  instagramId: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  ongkosKirim: number
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
  createdAt: string | null
  updatedAt: string | null
}

export interface CustomerInput {
  instagramId: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  ongkosKirim: number
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
}

export type RefundReason = "overpayment" | "unavailable" | "shipping_loss" | "damaged" | "goodwill" | "other"
export type RefundStatus = "pending" | "awaiting_bank_info" | "ready_to_refund" | "refunded" | "applied_to_next_order" | "cancelled"

export interface RefundRow {
  id: number
  event: string
  customer: string
  reason: RefundReason
  refundAmount: number
  status: RefundStatus
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
  transferReference: string
  paymentId: number | null
  orderId: number | null
  affectedUnits: number
  note: string
  createdAt: string | null
  updatedAt: string | null
}

/**
 * Arrival/ship state of a whole (customer, event) invoice, arrival-first:
 *   not_arrived — nothing has arrived yet
 *   partial       — some lines arrived but not every line is fully arrived
 *   ready         — fully arrived, units to ship, AND invoice is paid/overpaid
 *   ready_unpaid  — fully arrived with units to ship, but payment is not in yet
 *                   (split out from "ready" so ops can see what's payment-blocked)
 *   shipped       — every line fully arrived AND nothing left to ship
 */
export type ShipStatus = "not_arrived" | "partial" | "ready" | "ready_unpaid" | "shipped"

/**
 * Invoice totals for a (customer, event) pair — same math as getInvoiceForCustomer,
 * surfaced on each ship card so ops can verify amounts inline.
 *
 *   weightKg / ongkir are the BILLED invoice values (ceil of total gram → kg, and
 *   ongkos_kirim × billed kg) — distinct from ShipCustomer.weightKg / ongkirPerKg
 *   which apply only to the units actually being shipped.
 */
export interface InvoiceSummary {
  subtotal: number
  weightKg: number
  ongkir: number
  adjustments: number
  total: number
  paid: number
  outstanding: number
}

export interface ShipCustomer {
  customer: string
  event: string
  customerDetail: CustomerDetail | null
  orders: ShipOrderLine[]
  totalToShip: number
  weightKg: number
  ongkirPerKg: number
  status: ShipStatus
  paymentStatus: PaymentStatus
  invoice: InvoiceSummary
}

export interface InvoiceResult {
  customer: string
  customerDetail: CustomerDetail | null
  events: InvoiceEvent[]
}

// Minimal, PII-free shape for the public no-login invoice recap. Mirrors what
// the customer-facing page renders — orders + payment status — and nothing else.
export interface PublicInvoiceOrderLine {
  order: string
  unit: number
  price: string
  subtotal: string
  unitArrive: number
}

export interface PublicInvoiceEvent {
  eventId: string
  eta: string
  status: string
  shipments: InvoiceShipment[]
  showShipments: boolean
  orders: PublicInvoiceOrderLine[]
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
}

export interface PublicInvoiceResult {
  customer: string
  events: PublicInvoiceEvent[]
}

export interface ShipOrdersParams {
  customer: string
  event: string
  orders: Array<{ rowNumber: number; productId: number; productName: string; toShip: number; unitShip: number }>
  weightKg: number
  ongkirPerKg: number
}

/**
 * "Ship together": one customer's ready orders across several events shipped as
 * a single physical package. One shipment row is written per event (linked by a
 * merge_group), the combined weight/ongkir lands on the primary row, and a
 * single negative "Gabung ongkir" adjustment bills shipping once.
 */
export interface ShipMergedParams {
  customer: string
  ongkirPerKg: number
  groups: Array<{
    event: string
    orders: Array<{ rowNumber: number; productName: string; toShip: number; gram: number }>
  }>
}

export interface ShipMergedResult {
  mergeGroup: string
  shippingId: string        // the primary row's id (used for the combined label)
  shippingIds: string[]
  discount: number          // the merged-shipping ongkir discount applied (Rp)
  combinedKg: number        // physical weight of the combined package
  combinedOngkir: number    // physical ongkir of the combined package (Rp)
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
  // Non-null when this row is part of a "Ship together" merged package; all
  // rows sharing the id were one physical shipment (one box, one resi).
  mergeGroup: string | null
}

export interface CountryRow {
  id: number
  name: string
  currency: string
  kurs: number
  cargoPerKg: number
  createdAt: string
  updatedAt: string
}

export interface ProductRow {
  id: number
  name: string
  store: string
  price: number
  gram: number
  countryId: number | null
  countryName: string
  valas: number
  kurs: number
  cargoPerKg: number
  profitPct: number
  operationalFee: number
  packingFee: number
  cost: number
  profitFixed: number
  createdAt: string
  updatedAt: string
}

export interface ProductIndoRow {
  rowNumber: number
  product: string
  store: string
  price: number
  createdAt: string
  updatedAt: string
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

