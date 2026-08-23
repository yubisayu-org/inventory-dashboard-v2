/** Formats a bare digit string from a WhatsApp JID into a readable Indonesian
 *  phone number: +62 816-1859-595 (country code, 3 digits, 4 digits, rest).
 *  Falls back to a plain +-prefixed number for anything not starting with the
 *  Indonesian country code, and a placeholder for an empty string. */
export function formatIndonesianPhone(digits: string): string {
  if (!digits) return "(nomor tidak diketahui)"
  if (!digits.startsWith("62")) return `+${digits}`

  const local = digits.slice(2)
  const parts = [local.slice(0, 3), local.slice(3, 7), local.slice(7)].filter(Boolean)
  return `+62 ${parts.join("-")}`
}
