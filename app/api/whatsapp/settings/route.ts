import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import {
  listGroups, bindGroupToEvent, listBotAdmins, addBotAdmin, removeBotAdmin,
} from "@/lib/db/whatsapp-groups"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const [groups, admins] = await Promise.all([listGroups(), listBotAdmins()])
    return NextResponse.json({ groups, admins }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load WhatsApp settings:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()

    // Binding a group decides where a whole trip's claims land, so it stays with
    // the owner — the same reason /connect is not open to the admin list.
    if (typeof body.jid === "string") {
      await bindGroupToEvent(body.jid, body.event ? String(body.event) : null)
    }

    if (typeof body.number === "string" && body.number.trim()) {
      await addBotAdmin({
        number: body.number,
        label: String(body.label ?? ""),
        canConnect: Boolean(body.canConnect),
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to save WhatsApp settings:", err)
    return NextResponse.json({ error: "Failed to save" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const number = req.nextUrl.searchParams.get("number")
  if (!number) return NextResponse.json({ error: "number is required" }, { status: 400 })

  try {
    await removeBotAdmin(number)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to remove bot admin:", err)
    return NextResponse.json({ error: "Failed to remove" }, { status: 500 })
  }
}
