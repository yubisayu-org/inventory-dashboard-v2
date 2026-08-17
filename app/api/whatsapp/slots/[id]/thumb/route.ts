import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { renderSlotCrop } from "@/lib/whatsapp/render"

type Params = { params: Promise<{ id: string }> }

/**
 * A close-up of one slot, so it can be recognised while being named.
 *
 * Cacheable, unlike the shopping list: the photograph and the slot's position
 * do not change once captured, and only the counts drawn over the full picture
 * ever move.
 */
export async function GET(_req: Request, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const image = await renderSlotCrop(Number((await params).id))
    if (image === null) return NextResponse.json({ error: "Not found" }, { status: 404 })

    return new NextResponse(new Uint8Array(image), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
    })
  } catch (err) {
    console.error("Failed to render slot crop:", err)
    return NextResponse.json({ error: "Failed to render" }, { status: 500 })
  }
}
