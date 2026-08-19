import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { renderSlotCrop } from "@/lib/whatsapp/render"

type Params = { params: Promise<{ id: string }> }

/**
 * A close-up of one slot, so it can be recognised while being named.
 *
 * Cached briefly rather than for an hour. A slot's position is not as fixed as
 * it first appears — re-clustering moves it whenever a new claim lands, and the
 * ring drawn on the crop moves with it — so an hour of caching serves a picture
 * that has since stopped being true. A minute is enough to stop a scrolling
 * list re-rendering every thumbnail.
 */
export async function GET(req: Request, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    // How much of the shelf to show. Zooming in means cropping tighter, not
    // enlarging — the detail either survived the photograph or it did not.
    const share = Number(new URL(req.url).searchParams.get("share"))
    const image = await renderSlotCrop(
      Number((await params).id),
      Number.isFinite(share) && share > 0 ? share : undefined,
    )
    if (image === null) return NextResponse.json({ error: "Not found" }, { status: 404 })

    return new NextResponse(new Uint8Array(image), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=60" },
    })
  } catch (err) {
    console.error("Failed to render slot crop:", err)
    return NextResponse.json({ error: "Failed to render" }, { status: 500 })
  }
}
