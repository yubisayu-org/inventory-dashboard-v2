import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import {
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from "@/lib/db/announcements"

// Staff CRUD, owner-only — /dashboard/announcements is not in ADMIN_ROUTES.
//
// Guarded here, not by middleware. The middleware matcher is /dashboard/:path*,
// which never sees a path beginning /api, so this route answered anyone who
// asked — including POST, PATCH and DELETE. The comment that used to sit here
// said the opposite, which is presumably why nobody looked.
async function denyUnlessOwner(): Promise<NextResponse | null> {
  const { session, error } = await requireSession()
  if (error) return error
  return requireOwner(session)
}

const MAX_TITLE = 120
const MAX_BODY = 4000

function validate(body: Record<string, unknown>): { title: string; body: string } | string {
  const title = String(body.title ?? "").trim()
  const text = String(body.body ?? "").trim()
  if (!title) return "A title is required"
  if (!text) return "A message is required"
  if (title.length > MAX_TITLE) return `Title must be ${MAX_TITLE} characters or fewer`
  if (text.length > MAX_BODY) return `Message must be ${MAX_BODY} characters or fewer`
  return { title, body: text }
}

export async function GET() {
  const denied = await denyUnlessOwner()
  if (denied) return denied

  try {
    return NextResponse.json({ announcements: await listAnnouncements() })
  } catch (err) {
    console.error("Failed to list announcements:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const denied = await denyUnlessOwner()
  if (denied) return denied

  try {
    const parsed = validate((await req.json()) as Record<string, unknown>)
    if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 })
    return NextResponse.json({ announcement: await createAnnouncement(parsed) })
  } catch (err) {
    console.error("Failed to create announcement:", err)
    return NextResponse.json({ error: "Failed to save" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const denied = await denyUnlessOwner()
  if (denied) return denied

  try {
    const body = (await req.json()) as Record<string, unknown>
    const id = Number(body.id)
    if (!Number.isInteger(id) || id < 1) {
      return NextResponse.json({ error: "id must be a positive integer" }, { status: 400 })
    }
    const parsed = validate(body)
    if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 })
    await updateAnnouncement(id, parsed)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update announcement:", err)
    return NextResponse.json({ error: "Failed to save" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const denied = await denyUnlessOwner()
  if (denied) return denied

  try {
    const id = Number(new URL(req.url).searchParams.get("id"))
    if (!Number.isInteger(id) || id < 1) {
      return NextResponse.json({ error: "id must be a positive integer" }, { status: 400 })
    }
    await deleteAnnouncement(id)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete announcement:", err)
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 })
  }
}
