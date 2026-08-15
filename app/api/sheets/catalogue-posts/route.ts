import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getAllCataloguePosts, createCataloguePost } from "@/lib/db"
import { uploadCatalogueMedia } from "@/lib/storage"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const posts = await getAllCataloguePosts()
    return NextResponse.json({ posts }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch catalogue posts:", err)
    return NextResponse.json({ error: "Failed to fetch catalogue posts" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const form = await req.formData()
    const file = form.get("file")
    const caption = String(form.get("caption") ?? "")
    const productIdsRaw = String(form.get("productIds") ?? "[]")

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 })
    }
    let productIds: number[]
    try {
      productIds = JSON.parse(productIdsRaw)
      if (!Array.isArray(productIds) || !productIds.every((n) => Number.isInteger(n))) throw new Error()
    } catch {
      return NextResponse.json({ error: "productIds must be a JSON array of integers" }, { status: 400 })
    }

    const { url, mediaType } = await uploadCatalogueMedia(file)
    const result = await createCataloguePost({ mediaUrl: url, mediaType, caption, productIds })

    return NextResponse.json({ success: true, id: result.id })
  } catch (err) {
    console.error("Failed to create catalogue post:", err)
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create post" }, { status: 500 })
  }
}
