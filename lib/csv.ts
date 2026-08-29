/**
 * Reading and writing the spreadsheets people actually work in.
 *
 * Corrections come back from a human who opened the file in Excel, so the
 * parser has to survive what Excel does to a file: quoted fields, commas
 * inside them, doubled quotes, and CRLF endings. Its own module because two
 * scripts needed the same parser and the second one nearly copied the first.
 */

/** Minimal RFC-4180 parse: quoted fields, embedded commas, "" escapes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ",") {
      row.push(field); field = ""
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = ""
    } else if (c !== "\r") {
      field += c
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

/**
 * Quote a field only where it needs it.
 *
 * A postal code is the reason this matters: Excel reads 06170 as a number and
 * drops the leading zero unless the cell is quoted, and an address that comes
 * back with four digits is worse than one nobody touched.
 */
export function csvField(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value)
  return /[",\n\r]/.test(s) || /^0\d+$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** A whole file, header row first. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n"
}
