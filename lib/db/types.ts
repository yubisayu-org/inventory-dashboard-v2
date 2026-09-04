// Shared types for the db/* modules.

import type { PaymentStatus } from "./finance"
import type { FlatFeeMode, PricingMethod } from "@/lib/pricing"
import type { TierFeeMode, TierFeeScope } from "@/lib/tier-fee"

// ─── Types (same interfaces as the old sheets.ts) ───────────────────────────

export interface ItemOption {
  id: number
  name: string
  store: string
  price: number
  /** False when the product is deactivated — the List Order item picker drops
   *  inactive items; every other picker ignores this flag and shows them all. */
  active: boolean
}

export interface SheetOptions {
  events: string[]
  /** Subset of `events` that are active. Only the List Order event picker uses
   *  this; the other pickers keep using the full `events` list. */
  activeEvents: string[]
  items: ItemOption[]
  customers: string[]
  /** Canonical customer handle → mobile (whatsapp), shown as the customer
   *  picker's right-aligned meta. Absent/empty when the customer has no number. */
  customerMobiles: Record<string, string>
  /** Distinct payment accounts in use (e.g. "BCA", "JAGO") — the Payments
   *  page's Account field is free text with autocomplete, not a fixed set. */
  accounts: string[]
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
  unitDispatch: number | null
  dispatchReceipt: string
  unitHold: number | null
  // True when the customer's data_diri (free-text address blob) is filled.
  // Joined from the customers table by normalized handle; the List Order page
  // shows an amber warning icon when this is false.
  hasAddress: boolean
}

export type ExcessReason =
  | "overbuy" | "overship" | "wrong_product" | "broken" | "missing"
  | "customer_cancelled" | "manual"
  // A customer sent something back. Resellable goes on the shelf like any
  // other stock; the other is tracked so the loss is on the record, and is
  // excluded from everything that offers stock to a new order.
  | "returned" | "returned_unsellable"

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
  // Null means "not yet at this stage" — same convention as orders.unit_dispatch
  // / orders.unit_arrive. Set on every insert path; never left ambiguous by omission.
  unitDispatch: number | null
  unitArrive: number | null
  dispatchReceipt: string
  /** Item's sell price, joined by name from products — only populated by the
   *  paginated fetch (for display); undefined elsewhere. */
  price?: number | null
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

export interface DispatchUpdate {
  rowNumber: number
  unitDispatch: number
  dispatchReceipt: string
}

export interface ExcessDispatchUpdate {
  rowNumber: number
  unitDispatch: number
  dispatchReceipt: string
}

export interface ExcessArriveUpdate {
  rowNumber: number
  unitArrive: number
}

/** One excess_purchase row still moving through buy -> dispatch -> arrive, for
 *  the "Overbuy in transit" section on the Dispatch List / Receiving List
 *  pages. `pending` is stage-specific: unitBuy - unitDispatch when sourced from
 *  getExcessDispatchPending, unitDispatch - unitArrive from getExcessArrivalPending. */
export interface ExcessTransitItem {
  rowNumber: number
  event: string
  items: string
  // Joined by item-name from products (excess_purchase.items isn't FK'd) —
  // same name-collision-across-stores caveat as the Inventory page's price
  // join, so a bare name shared by multiple stores picks one arbitrarily.
  store: string
  reason: ExcessReason
  unitBuy: number
  unitDispatch: number
  unitArrive: number
  pending: number
  receipt: string
}

export interface InvoiceOrderLine {
  order: string
  unit: number
  price: string
  subtotal: string
  unitArrive: number
  // Raw fields for pre-filling the refund / cancel modals
  orderId: number
  productName: string
  rawUnitPrice: number
  // Units purchased for this line — how many can return to Inventory on a
  // customer cancellation (0 when not yet bought).
  unitBuy: number
  // Units already sent. A line whose parcel has gone cannot be cancelled: the
  // journey happened, and what is owed for it is a refund's business.
  unitShip: number
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
  unitPrice: number
  unitArrive: number
  unitShip: number
  unitHold: number
  toShip: number
}

export interface CustomerDetail {
  name: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
}

// Per-warehouse shipping rate, keyed by warehouse id. The shipping cost a
// customer pays now depends on which warehouse an order ships from (the event's
// warehouse), so a single ongkos_kirim is replaced by this map.
export type OngkirByWarehouse = Record<number, number>

export interface CustomerRow {
  id: number
  instagramId: string
  name: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  /**
   * What a parcel is priced at — the courier's quote, or our own rate when
   * there is none. The same figure the invoice charges, so the list, the sort
   * and the filter all agree with the money.
   */
  ongkir: OngkirByWarehouse
  /**
   * Our own rate, on its own: the only one of the two that can be written.
   * `effective_ongkir` is generated by the database and refuses to be set, so
   * this is what the customer editor edits — and it is used only where the
   * courier gave no quote at all.
   */
  ongkirFallback: OngkirByWarehouse
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
  /** Where she lives, as the courier needs it. Empty until somebody fills it. */
  jalan: string
  kota: string
  kecamatan: string
  provinsi: string
  kodePos: string
  /** The Biteship area her address resolved to, or null while it has not. */
  biteshipAreaId: string | null
  biteshipAreaName: string | null
  // Invoice roll-up from customer_invoice_summary (0 for callers that don't
  // join it, e.g. the full getCustomers list). totalOutstanding > 0 = owes,
  // < 0 = overpaid, 0 = settled. Voids excluded from invoiceCount.
  invoiceCount: number
  totalInvoiced: number
  totalOutstanding: number
  /** True once this customer has bound a Google account and can sign in to the
   *  catalogue site. Derived from google_sub — the address itself is never
   *  collected, since the OAuth request asks for `openid` scope only. */
  catalogueSignedIn: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface CustomerInput {
  instagramId: string
  name: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  ongkir: OngkirByWarehouse
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
  /**
   * Where she lives, when the caller knows it.
   *
   * Optional, and written only when present: the customer form has always had
   * her address as one free-text `dataDiri` blob, and a save from a screen that
   * does not ask for these must not blank the ones the catalogue set.
   *
   * The Biteship area is passed alongside rather than derived, because the
   * screen that asks for it is the screen that showed her the choice --
   * deriving it again here would be a second set of rules for one question.
   */
  jalan?: string
  kota?: string
  kecamatan?: string
  provinsi?: string
  kodePos?: string
  biteshipAreaId?: string | null
  biteshipAreaName?: string | null
}

export interface WarehouseRow {
  id: number
  code: string
  name: string
  isDefault: boolean
  /** Biteship origin. Null until set in Settings; rate lookups stay dormant
   *  and fall back to jne_rates until then. */
  biteshipAreaId: string | null
  biteshipAreaName: string | null
  postalCode: string
}

// Free text — "overpayment" stays special-cased in code (materializeOverpaymentRefunds,
// the apply-as-credit flow, the one-active-overpayment unique index), but any other
// reason is just a label. REFUND_REASONS are the suggested presets in the picker.
export type RefundReason = string
export const REFUND_REASONS: RefundReason[] = ["overpayment", "unavailable", "shipping_loss", "damaged", "wrong_item", "customer_cancelled", "quality", "goodwill", "other"]
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
  /** True when this refund has linked `credit` payments — i.e. some/all of it
   *  was applied to another order and can be undone. */
  hasAppliedCredit: boolean
  /** Total applied as credit to other orders (sum of the +credit legs). For a
   *  fully-applied refund `refundAmount` is 0 (no overpayment remaining), so the
   *  UI shows this instead. */
  appliedCreditAmount: number
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
 *   hold          — customer asked to delay shipment (usually to combine with a
 *                   later event); unit_hold absorbs the toShip qty so the card
 *                   drops out of "ready" until released.
 *   shipped       — every line fully arrived AND nothing left to ship
 */
export type ShipStatus =
  | "not_arrived"
  | "partial"
  // She asked for what has arrived to go early. Its own status rather than a
  // marker on "partial", because it is a queue of work: the extra delivery fee
  // has to be billed and paid before the parcel goes.
  | "split_requested"
  // Two or more events the customer asked to travel in one box. Its own status
  // so a paired order appears in the Gabung tab and nowhere else — two places
  // for one card is two chances to ship it twice.
  | "paired"
  | "ready"
  | "ready_unpaid"
  | "hold"
  | "shipped"

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
  /**
   * A one-off address the customer asked for on this event, from
   * customer_shipping_prefs. Null when she has not asked for one, which is
   * the usual case — then the label uses her profile address as before.
   */
  requestedAddress: string | null
  /**
   * True when that address sits in a different Biteship area than her profile
   * — her standing ongkir was priced for the other one, so the cost may not
   * match. Surfaced, never re-rated automatically.
   */
  requestedOtherArea: boolean
  /** She asked for the arrived part to go early, and it has not gone yet. */
  splitRequested: boolean
  /**
   * What sending early costs on top of what the invoice already charges:
   * (ongkir on this parcel + ongkir on the rest) − ongkir on the whole event.
   * The mirror image of the "Gabung ongkir" discount — same weights, same
   * rounding, opposite sign.
   */
  splitExtraOngkir: number
  /** Whether that fee has already been put on her invoice. */
  splitCharged: boolean
  /** The group this event travels in, when she has paired it with another. */
  mergeKey: string | null
  /** The other events in that group. */
  pairedWith: string[]
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
  /** Already sent. */
  unitShip: number
  /** Deliberately kept back, at her own request. */
  unitHold: number
  /** Arrived, not held, not yet sent — what would go if she sent now. */
  unitReady: number
}

export interface PublicInvoiceEvent {
  eventId: string
  eta: string
  status: string
  shipments: InvoiceShipment[]
  showShipments: boolean
  /**
   * What it would cost her to have the arrived part sent ahead of the rest —
   * shown in the shipping sheet so the choice carries its price. An estimate,
   * from estimated weights, and nothing is charged until the shop bills it.
   */
  splitExtraOngkir: number
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
  /**
   * Ship this event on its own even though the customer paired it with
   * another. The confirm behind it says what that costs her; setting it also
   * dissolves the pairing, since half a pair is not one.
   */
  force?: boolean
  orders: Array<{ rowNumber: number; productId: number; productName: string; toShip: number; unitShip: number }>
  weightKg: number
  ongkirPerKg: number
  // Optional one-time receiving address. When provided, persisted on the
  // resulting shipment row so reprints/messages render this address instead of
  // the customer's profile data_diri.
  tempAddress?: string | null
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
  // Optional one-time receiving address for the combined package. Written to
  // every row in the merge_group so any reprint path renders it consistently.
  tempAddress?: string | null
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
  customerName: string  // joined from customers.name; "" when unknown/backfill missed
  shippingId: string
  invoicing: string
  weightEstimation: number
  /**
   * Kilos the courier actually billed, when that differed from the estimate.
   * Null means it did not, which is most parcels — and is what the row's
   * corrected-weight marker keys off.
   */
  weightCharged: number | null
  ongkir: number
  ongkirTotal: number
  isLastShipment: boolean
  createdAt: string
  updatedAt: string
  // Epoch ms for chronological sorting — createdAt/updatedAt are localized
  // display strings (DD/MM/YYYY …) that don't sort by date as text. 0 when null.
  createdAtTs: number
  updatedAtTs: number
  trackingNumber: string
  // Non-null when this row is part of a "Ship together" merged package; all
  // rows sharing the id were one physical shipment (one box, one resi).
  mergeGroup: string | null
  // One-time override of the receiving address. When set, label generation,
  // reprints, and the shipment confirmation message all use this instead of
  // the customer's profile data_diri. Persisted on every row of a merge_group.
  tempAddress: string | null
}

export interface CountryRow {
  id: number
  name: string
  currency: string
  kurs: number
  /** The rate CHARGED to a Flat Kurs product from this country (migration 053), as opposed
   *  to `kurs`, which is what its goods COST. 0 means unset — see resolveFlatKurs(). */
  flatKurs: number
  cargoPerKg: number
  createdAt: string
  updatedAt: string
}

/**
 * One Tier Kurs bracket: from `minValas` upward, charge `kurs` instead of the
 * country's flat rate. `minValas` is INCLUSIVE and the highest matching minimum
 * wins — the resolution itself lives in lib/kurs-tiers.ts.
 */
export interface KursTierRow {
  id: number
  countryId: number
  minValas: number
  kurs: number
  createdAt: string
  updatedAt: string
}

/**
 * One Tier Fee bracket: from `minBase` upward, charge this much
 * fixed profit. `minBase` is INCLUSIVE and the highest matching minimum wins — the
 * resolution lives in lib/tier-fee.ts.
 *
 * A SUGGESTION for the Add Product form, not a stored pricing rule: see
 * migration 051.
 */
export interface TierFeeBracketRow {
  id: number
  /** Which set this bracket belongs to. Both are rupiah — see TierFeeScope. */
  scope: TierFeeScope
  minBase: number
  feeMode: TierFeeMode
  feeValue: number
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
  /** The country's currency code, for labelling amounts held in it — valas most
   *  of all, which is meaningless without its unit. Empty string when there is no
   *  country. */
  countryCurrency: string
  valas: number
  kurs: number
  /** The tiered rate this row was priced with, snapshotted at save time like
   *  `kurs`. Null unless pricingMethod is "tier_kurs". See lib/kurs-tiers.ts. */
  tieredKurs: number | null
  cargoPerKg: number
  profitPct: number
  operationalFee: number
  packingFee: number
  cost: number
  profitFixed: number
  /** Whether this row's Flat Fee is a fixed amount or a share of base cost
   *  (migration 054). Meaningless for the other three methods, which ignore it. */
  flatFeeMode: FlatFeeMode
  /** Which formula prices this row. Replaced `country_id IS NULL` as the
   *  discriminator in migration 050 — a Tier Kurs product has a country but must
   *  not use the overseas formula. */
  pricingMethod: PricingMethod
  /** False when deactivated — hidden from the List Order item picker. */
  isActive: boolean
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

/** deposit = money in · refund = cash out · credit = internal overpayment transfer */
export type PaymentKind = "deposit" | "refund" | "credit"

export interface PaymentRow {
  rowNumber: number
  event: string
  customer: string
  amount: number
  account: string
  isChecked: boolean
  payDate: string
  remarks: string
  kind: PaymentKind
  createdAt: string
  updatedAt: string
  /** A photo of the transfer she chose to attach. Empty for most rows: the
   *  shop matches on amount and sender name from the bank's own mutasi, so a
   *  receipt is offered, never asked for. */
  receiptUrl: string
  /** 'customer' when she filed it herself from the catalogue. */
  reportedBy: "shop" | "customer"
  /** When the shop said it could not confirm this payment. */
  rejectedAt: string | null
  /** Why, in words the customer reads. Empty unless rejectedAt is set. */
  rejectReason: string
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

/** Free text (no DB constraint, same as `method`) — users can add new
 *  categories on the fly via the dashboard's SearchableSelect+allowNewValue. */
export type ExpenseCategory = string

/** Suggested categories offered in the picker; not an exhaustive list. */
export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  "Flight", "Lodging", "Cargo", "Meal", "Transport", "Shop",
  "Supplies", "Delivery", "Personal", "Payroll", "Dividend", "Other"
]

/** One operational expense row (replaces the "Operational_2026" sheet). */
export interface OperationalExpenseRow {
  rowNumber: number
  event: string
  /** ISO date (YYYY-MM-DD), or "" when unset. */
  expenseDate: string
  description: string
  category: ExpenseCategory
  /** Cost in the currency it was paid in (the "# VLS" column). */
  amountForeign: number
  /** What that currency was. Null on rows added before it was recorded — the
   *  screen falls back to inferring it, which is all those rows allow. */
  currency: string | null
  /** IDR per unit of foreign currency (the "Kurs" column); 1 for IDR rows. */
  rate: number
  /** Cost in rupiah (the "IDR" column). */
  amountIdr: number
  isSettled: boolean
  /** Payment method — card last-4, account label, etc. */
  method: string
  remarks: string
  createdAt: string
  updatedAt: string
}

export interface CatalogueHighlight {
  id: number
  name: string
  defaultEvent: string | null
  sortOrder: number
  visible: boolean
  createdAt: string
  updatedAt: string
}

export interface CataloguePost {
  id: number
  mediaUrl: string
  mediaType: "photo" | "video"
  /** The one title this post is always sent under — see the rename in
   *  migration 086; this used to be a separate "caption" field. */
  title: string
  visible: boolean
  createdAt: string
  updatedAt: string
  highlightId: number | null
  /** Products tagged in this post. */
  productIds: number[]
  /** Whether this post has ever actually gone out to a WhatsApp group —
   *  gates whether "Kirim ulang" (quick-resend) is offered at all. */
  everSent: boolean
  /** How many of `productIds` have a placed pin (from any send that ever
   *  carried them) — used to tell whether tagging is actually finished. */
  pinnedCount: number
}

export interface CatalogueRequest {
  id: number
  customerHandle: string
  productId: number | null
  productName: string | null
  /** Catalogue price of the requested product, for a Fix request. Null on a
   *  custom request, which has estimatedPrice instead, and null on the staff
   *  paths that do not SELECT it. */
  productPrice: number | null
  description: string
  referenceImageUrl: string | null
  qty: number
  note: string
  status: "pending" | "offer_pending" | "approved" | "asking" | "converted" | "rejected"
  staffNote: string
  convertedOrderId: number | null
  createdAt: string
  countryId: number | null
  countryName: string | null
  valas: number | null
  gram: number | null
  estimatedPrice: number | null
  /** Which formula the owner's proposal (editCatalogueRequest) used to
   *  arrive at estimatedPrice — defaults to 'overseas' on a fresh request
   *  that's never been proposed. */
  proposedPricingMethod: "overseas" | "tier_kurs"
  /** The exact profit%/fees the owner proposed under Profit Margin — set
   *  only once an offer has actually been proposed that way, null
   *  otherwise (including when proposedPricingMethod is 'tier_kurs', which
   *  doesn't use these). Lets "Create product from approved offer" start
   *  from what was actually approved instead of guessing at a fixed
   *  default. */
  proposedProfitPct: number | null
  proposedOperationalFee: number | null
  /** Applies under either method — Tier Kurs still has a packing fee. */
  proposedPackingFee: number | null
  /** The rate actually charged under Tier Kurs, resolved server-side and
   *  snapshotted the same way products.tiered_kurs is — null unless
   *  proposedPricingMethod is 'tier_kurs'. */
  proposedTieredKurs: number | null
  /** The product name the owner set while quoting a price (migration 093) —
   *  separate from `description`, which stays what the customer originally
   *  typed. Null until a quotation has been made. */
  proposedName: string | null
  postId: number | null
  /** Resolved from post -> highlight -> default_event, unconditionally —
   *  the caller (ConvertModal) is responsible for checking it's still in
   *  the active events list before using it as a picker default. Owner-read
   *  path only, see getCatalogueRequests — the public status-lookup path
   *  never populates this (stays null), since a customer has no use for
   *  staff's purchasing-event bookkeeping. */
  defaultEvent: string | null
  /** WhatsApp claim inbox fields (migration 081). 'catalogue' for every row
   *  written by the public/staff paths above; 'whatsapp' plus the rest of
   *  these fields populated only for rows written by
   *  createDirectClaim/createAskingRequest/createRejectedClaim in
   *  lib/db/catalogue-requests.ts. Rows fetched through
   *  getCatalogueRequestsByHandle/getCatalogueRequests (which SELECT an
   *  explicit column list that doesn't include these) fall back to
   *  source: 'catalogue' and the rest empty/null, same as an actual
   *  'catalogue'-sourced row would read. */
  source: "catalogue" | "whatsapp"
  sendId: number | null
  sendCodeId: number | null
  sender: string
  messageId: string
  botMessageId: string
  candidateSendCodeIds: number[] | null
  /** The code this row is claimed against, if any (via send_code_id) —
   *  joined from wa_send_codes. null when send_code_id is null (a
   *  'catalogue'-source row, or an unresolved 'asking' row). Owner-read
   *  path only, see getCatalogueRequests. */
  resolvedCode: string | null
  /** Which send resolvedCode belongs to — for a future "view post" link.
   *  null exactly when resolvedCode is null. */
  resolvedCodeSendId: number | null
  /** The trip a WhatsApp-sourced row's claim was made against — joined from
   *  wa_sends.event via send_id, NOT from postId/defaultEvent (a WhatsApp
   *  row's post_id is always null, so defaultEvent is always null for it —
   *  see the final whole-branch review's finding 4). Populated for BOTH a
   *  resolved claim and a still-open 'asking' row (send_id is set from the
   *  moment the row is created, independent of which candidate — if any —
   *  it eventually resolves to). Distinct from defaultEvent (which stays
   *  the catalogue-web highlight-derived suggestion for a 'catalogue'-
   *  source row) — deliberately NOT merged into that field, since one is an
   *  authoritative fact about a WhatsApp row and the other is only ever a
   *  suggestion. Owner-read path only, see getCatalogueRequests; null for
   *  a 'catalogue'-source row and for the public status-lookup path. */
  resolvedEvent: string | null
  /** For an 'asking' row, the candidate codes she could mean — batch-resolved
   *  from candidateSendCodeIds by getCatalogueRequests so the dashboard's
   *  disambiguation picker needs no extra client-side fetch. null when
   *  candidateSendCodeIds is null/empty. */
  candidates: { id: number; code: string; productId: number; productName: string; price: number }[] | null
}

