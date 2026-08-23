import { NextRequest, NextResponse } from "next/server"
import {
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from "@/lib/db/announcements"

// Staff CRUD. Guarded by the dashboard middleware, like every other
// /api route that is not under /api/public.

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
  try {
    return NextResponse.json({ announcements: await listAnnouncements() })
  } catch (err) {
    console.error("Failed to list announcements:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
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
