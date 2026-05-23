import { auth } from "@/auth"
import { NextResponse } from "next/server"

export default auth((req) => {
  const { pathname } = req.nextUrl
  const role = req.auth?.user?.role ?? null

  // Not logged in → send to login
  if (!req.auth) {
    return NextResponse.redirect(new URL("/login", req.url))
  }

  // Logged in but no recognized role → send to login (unauthorized)
  if (!role) {
    return NextResponse.redirect(new URL("/login?error=unauthorized", req.url))
  }

  // Owner-only routes (Database section): only "owner" role allowed
  const ownerOnlyPaths = [
    "/dashboard/products",
    "/dashboard/customers",
    "/dashboard/countries",
    "/dashboard/events",
  ]
  if (ownerOnlyPaths.some((p) => pathname.startsWith(p)) && role !== "owner") {
    return NextResponse.redirect(new URL("/dashboard", req.url))
  }
})

export const config = {
  matcher: ["/dashboard/:path*"],
}
