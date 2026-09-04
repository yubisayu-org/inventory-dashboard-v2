import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { uploadQrisImage } from "@/lib/storage"

// Puts the shop's static QRIS code in Storage and hands back its URL, which
// Settings then saves onto the business profile.
//
// Owner only, like the rest of the profile: this image is what customers are
// told to scan, so whoever can replace it can redirect their money. Read
// access gives an attacker nothing — a static QR carries no credentials and
// can only pay the shop — but write access gives away everything.

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const form = await req.formData()
    const file = form.get("file")
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 })
    }

    const { url } = await uploadQrisImage(file)
    return NextResponse.json({ url })
  } catch (err) {
    // Everything uploadQrisImage throws is something she can act on — a PDF
    // instead of a picture, a file too big — so the message goes back.
    const message = err instanceof Error ? err.message : "Upload failed"
    console.error("Failed to upload QRIS image:", err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
