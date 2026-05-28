// Template for the WhatsApp confirmation message sent to a customer after
// (or while) their package is being shipped. Used by:
//   - /dashboard/shipments  (post-ship)  — items come from shipments.invoicing
//   - /dashboard/ship       (packing)    — items come from the ready-to-ship rows
//
// `dataDiri` is the free-text address blob the customer wrote at registration —
// it usually contains their name, phone, and full address on separate lines,
// so we paste it verbatim instead of breaking it into labeled fields.

import { displayIg } from "./format"

export interface ShipmentConfirmMessageInput {
  /** Event id, or "EVT1 + EVT2" for a merged shipment. */
  event: string
  /** Customer instagram handle in any stored form; the "@" is stripped. */
  customer: string
  /** Customer's free-text address blob. Pasted verbatim. */
  dataDiri: string
  /**
   * One line per packed line item, already formatted as "Product x N".
   * Caller decides whether to consolidate or keep one entry per order row.
   */
  items: string[]
}

export function buildShipmentConfirmMessage(input: ShipmentConfirmMessageInput): string {
  const { event, customer, dataDiri, items } = input
  const handle = displayIg(customer)
  return [
    "Konfirmasi Pengiriman Yubisayu",
    `${event} ${handle}`,
    "",
    dataDiri,
    "",
    ...items,
    "",
    "Paket sedang dikemas dan akan segera dikirim.",
    "",
    "Cek kembali detail pesanan (jumlah, ukuran, warna jika ada) dan alamat, info jika ada perubahan alamat.",
    "",
    "Cek resi https://yubisayu-invoice.netlify.app/ atau WA Channel.",
    "",
    "Mohon konfirmasi jika paket sudah diterima.",
    "",
    "Sebelum dikirim, barang dicek dan dikirim dalam kondisi baik. Paket dikirim oleh ekspedisi, wajib video unboxing tanpa terputus.",
    "",
    "Tanpa video unboxing tidak terputus, mohon maaf claim jika ada kerusakan/kesalahan tidak bisa dibantu.",
    "",
    "Terima kasih.",
  ].join("\n")
}
