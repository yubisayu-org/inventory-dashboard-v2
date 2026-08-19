import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getSend, listSendCodes } from "@/lib/db/wa-sends"
import { renderCaption } from "@/lib/whatsapp/product-post"

type Params = { params: Promise<{ id: string }> }

/** The exact caption a send would go out with right now, computed by the
 *  one real `renderCaption` — never duplicated client-side — so the
 *  composer's live preview can never drift from what actually gets sent. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const id = Number((await params).id)
  const send = await getSend(id)
  if (!send) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const codes = await listSendCodes(id)
  return NextResponse.json(
    { caption: renderCaption({ title: send.title }, codes) },
    { headers: { "Cache-Control": "no-store" } },
  )
}
