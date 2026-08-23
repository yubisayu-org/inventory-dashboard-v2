import type { NextRequest } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"

/**
 * Members-only, enforced at the source.
 *
 * The catalogue site has its own gate, but that is a proxy: anyone who knows
 * this dashboard's URL could read the whole feed — product names, stores and
 * prices — straight from here, whatever the customer site said. A gate that
 * only exists on the caller is not a gate.
 *
 * Unset or malformed means open, matching the catalogue's own default: a typo
 * in an env var must never lock every customer out.
 */
export async function browseAllowed(req: NextRequest): Promise<boolean> {
  if (process.env.PUBLIC_BROWSE !== "false") return true
  return (await customerFromRequest(req)) !== null
}
