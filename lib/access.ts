import type { Role } from "./roles"

/**
 * Dashboard route prefixes an admin may access. Owners can access everything.
 * This is the single source of truth consumed by both the middleware (route
 * protection) and the sidebar (link visibility), so the two cannot drift apart.
 */
export const ADMIN_ROUTES = [
  "/dashboard/list-order",
  "/dashboard/catalogue-posts",
  "/dashboard/invoice",
  "/dashboard/payments",
  "/dashboard/adjustments",
  "/dashboard/refunds",
  "/dashboard/ship", // Packing List
  "/dashboard/shipments",
  "/dashboard/custom-label",
  "/dashboard/customers",
  "/dashboard/excess-purchase", // Inventory (ready stock)
  // Group Order, whole: an admin names, prices and records orders here. The
  // count itself is still the owner's, guarded on the slot route rather than
  // by hiding the page.
  "/dashboard/shop",
  // The catalogue an admin keeps day to day — posting, tagging, and deciding
  // what the customer site shows.
  "/dashboard/catalogue-posts",
] as const

/** Where an admin lands after login and when redirected off a blocked route. */
export const ADMIN_HOME = "/dashboard/list-order"

export function canAccessRoute(role: Role, pathname: string): boolean {
  if (role === "owner") return true
  return ADMIN_ROUTES.some((p) => pathname === p || pathname.startsWith(p + "/"))
}
