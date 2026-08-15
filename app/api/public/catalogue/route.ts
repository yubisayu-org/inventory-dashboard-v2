import { NextResponse } from "next/server"
import { getVisibleCataloguePosts } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"

// Public, no-login endpoint for the customer-facing catalogue site (a
// separate repo/deploy, mirroring how yubisayu-invoice.netlify.app consumes
// /api/public/invoice). Not matched by middleware (which only guards
// /dashboard), so it is intentionally reachable without a session.
//
// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET() {
  try {
    const posts = await getVisibleCataloguePosts(catalogueSql)
    const productIds = [...new Set(posts.flatMap((p) => p.productIds))]
    const products = productIds.length
      ? await catalogueSql`SELECT id, name, store, price FROM products WHERE id IN ${catalogueSql(productIds)}`
      : []
    const byId = new Map(products.map((p) => [p.id as number, { id: p.id as number, name: p.name as string, store: p.store as string, price: p.price as number }]))
    const withProducts = posts.map((post) => ({
      ...post,
      products: post.productIds.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => p != null),
    }))
    return NextResponse.json(
      { posts: withProducts },
      { headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to load catalogue posts:", err)
    return NextResponse.json(
      { error: "Failed to load catalogue" },
      { status: 500, headers: corsHeaders() },
    )
  }
}
