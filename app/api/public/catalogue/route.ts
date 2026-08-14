import { NextResponse } from "next/server"
import { getVisibleCataloguePosts } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"

// Public, no-login endpoint for the /catalogue browse page. Same-origin
// (served from this app), so no CORS allowlist is needed — unlike
// /api/public/invoice, which serves a separate site.
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
    return NextResponse.json({ posts: withProducts }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load catalogue posts:", err)
    return NextResponse.json({ error: "Failed to load catalogue" }, { status: 500 })
  }
}
