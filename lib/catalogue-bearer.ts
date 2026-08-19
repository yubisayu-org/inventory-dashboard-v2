import type { NextRequest } from "next/server"
import { resolveSession } from "@/lib/db/catalogue-auth"
import catalogueSql from "@/lib/db-catalogue-public"

/**
 * The customer behind a request, or null.
 *
 * Resolved under the least-privilege catalogue_public role: on the public
 * request path this is all the database access that should be reachable, and
 * that role has SELECT on four columns of customers and nothing else.
 */
export async function customerFromRequest(req: NextRequest) {
  const header = req.headers.get("authorization") ?? ""
  const match = /^Bearer (.+)$/.exec(header)
  if (!match) return null
  return resolveSession(match[1], catalogueSql)
}

/** The raw bearer token, for the one caller that revokes rather than reads. */
export function bearerToken(req: NextRequest): string | null {
  const match = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")
  return match ? match[1] : null
}
