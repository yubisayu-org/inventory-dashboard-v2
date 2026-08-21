import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getRequestProofData } from "@/lib/db/catalogue-requests"
import { renderProofBubble } from "@/lib/whatsapp/proof-image"
import { formatIndonesianPhone } from "@/lib/format-phone"

type Params = { params: Promise<{ id: string }> }

/** A WhatsApp-style chat-bubble image of exactly what a customer wrote, her
 *  number, and when — built from what's already stored at receipt time, not
 *  a new capture. Owner-only, same as every other order-requests route. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const id = Number((await params).id)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  const data = await getRequestProofData(id)
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const [user] = data.sender.split("@")
  const number = (user ?? "").split(":")[0].replace(/\D/g, "")
  const phone = formatIndonesianPhone(number)

  const png = await renderProofBubble({
    customerHandle: data.customerHandle,
    phone,
    text: data.note,
    event: data.event,
    sentAt: data.createdAt,
  })

  return new NextResponse(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="proof-${id}.png"`,
    },
  })
}
