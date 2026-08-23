import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { renderShoppingList } from "@/lib/whatsapp/render"

type Params = { params: Promise<{ id: string }> }

/**
 * The shopping list as an image.
 *
 * Rendered per request rather than cached: claims arrive over hours, and a
 * stale picture of what to buy is worse than a slow one. It takes well under a
 * second for a shelf photograph.
 */
export async function GET(_req: Request, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  try {
    const image = await renderShoppingList(id)
    return new NextResponse(new Uint8Array(image), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("no such post")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    console.error("Failed to render the shopping list:", err)
    return NextResponse.json({ error: "Failed to render" }, { status: 500 })
  }
}
