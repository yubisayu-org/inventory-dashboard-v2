import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { createSend } from "@/lib/db/wa-sends"

/** Start a new composed send for a catalogue post. Owner-only: this is the
 *  first step of building a message that will go out to a WhatsApp group. */
export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const body = await req.json()
  const { postId, event, title } = body
  if (typeof postId !== "number" || typeof event !== "string" || !event || typeof title !== "string") {
    return NextResponse.json(
      { error: "postId (number), event (string), and title (string) are required" },
      { status: 400 },
    )
  }

  const { id } = await createSend({ postId, event, title })
  return NextResponse.json({ success: true, id })
}
