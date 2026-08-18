import { randomBytes } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"
import { storeShelf } from "@/lib/whatsapp/shelf"

/**
 * Add a shelf from the dashboard rather than from the group.
 *
 * The reason this exists is quality: a photo sent from the owner's phone is
 * re-encoded by WhatsApp before it leaves — about 1280 across, which leaves a
 * price tag a few dozen pixels tall. Uploaded here it arrives as the camera
 * shot it, HEIC included, and is stored at 3000px.
 *
 * Open to admins as well as owners: this is the photographing half of the job,
 * the same half `/mulai` already trusts an admin with.
 *
 * One shelf per request rather than a batch. A trip is forty racks over a shop
 * connection that drops, and a failed batch of forty is worse than one failed
 * rack out of forty — the client uploads them one at a time and can retry the
 * one that fell over.
 */
export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const form = await req.formData()
    const file = form.get("file")
    const event = String(form.get("event") ?? "").trim()
    const store = String(form.get("store") ?? "").trim()
    const note = String(form.get("note") ?? "").trim()

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A photo is required" }, { status: 400 })
    }
    if (!event) {
      return NextResponse.json({ error: "An event is required" }, { status: 400 })
    }

    const [row] = await sql`SELECT is_active FROM events WHERE name = ${event}`
    if (!row) return NextResponse.json({ error: "No such event" }, { status: 400 })
    if (!row.is_active) {
      return NextResponse.json({ error: "That trip is closed" }, { status: 400 })
    }

    // Random rather than the filename: two phones both hand over IMG_4821.HEIC,
    // and a shelf must never overwrite another shelf.
    const path = `${event}/upload-${randomBytes(8).toString("hex")}.jpg`
    const shelf = await storeShelf({
      event,
      store,
      note,
      body: Buffer.from(await file.arrayBuffer()),
      path,
    })

    return NextResponse.json({ ...shelf, event, store })
  } catch (err) {
    console.error("Failed to upload a shelf:", err)
    return NextResponse.json({ error: "Failed to upload" }, { status: 500 })
  }
}
