import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, requireOwner } from "@/lib/api"
import { getNoticeTemplates, updateNoticeTemplate, withActor } from "@/lib/db"
import { cached, invalidate } from "@/lib/route-cache"
import { NOTICE_KEYS, unknownTokens, type NoticeKey } from "@/lib/notice-templates"

// Reading matches message-templates: any logged-in session, because this is
// wording they already see rendered in the composer. Writing is the owner's,
// because it changes what every future customer reads.

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const overrides = await cached("notice-templates", getNoticeTemplates)
    return NextResponse.json({ overrides }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch notice templates:", err)
    return NextResponse.json({ error: "Failed to fetch notice templates" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const { key, title, body } = await req.json()

    if (!NOTICE_KEYS.includes(key)) {
      return NextResponse.json({ error: "Invalid notice key" }, { status: 400 })
    }
    if (typeof title !== "string" || typeof body !== "string") {
      return NextResponse.json({ error: "A title and a message are both required" }, { status: 400 })
    }
    if (!title.trim()) {
      return NextResponse.json({ error: "A notice needs a title" }, { status: 400 })
    }

    // The same guard sendInvoiceNotice applies at send time, moved earlier: a
    // typo'd placeholder saved here would block every send that uses it, and
    // the person who could fix it would not be the one seeing the error.
    const bad = unknownTokens(`${title} ${body}`)
    if (bad.length > 0) {
      return NextResponse.json(
        { error: `${bad.join(", ")} is not a placeholder we know` },
        { status: 400 },
      )
    }

    await withActor(session.user.email, (tx) =>
      updateNoticeTemplate(key as NoticeKey, { title, body }, tx))
    invalidate("notice-templates")
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to update notice template:", err)
    return NextResponse.json({ error: "Failed to update notice template" }, { status: 500 })
  }
}
