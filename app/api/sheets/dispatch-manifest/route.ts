import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import {
  getBoxManifest, getEventBoxes, getUncodedReceived, getUncodedPacked, getUncodedByCargo,
} from "@/lib/db"

/**
 * What was in a box, or which boxes a trip sent.
 *
 * `?receipt=CJI-2607` gives one box, packed against served. `?event=…` lists
 * the trip's boxes so one can be picked.
 */
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const params = req.nextUrl.searchParams
  const receipt = (params.get("receipt") ?? "").trim()
  const event = (params.get("event") ?? "").trim()

  try {
    if (receipt) {
      const manifest = await getBoxManifest(receipt)
      if (!manifest) {
        return NextResponse.json({ error: `Nothing was recorded as packed in ${receipt}` }, { status: 404 })
      }
      return NextResponse.json({ manifest }, { headers: { "Cache-Control": "no-store" } })
    }
    if (event) {
      // The uncoded units travel with the list, because they are a group on
      // the same screen -- a card you can pick, and a heading in the document.
      // Split by delivery as well as totalled: a pile with no box code but a
      // cargo on it is identifiable, and gets a card; the pile with neither is
      // the one nobody can trace, and it goes last.
      const [boxes, uncoded, uncodedPacked, uncodedByCargo] = await Promise.all([
        getEventBoxes(event), getUncodedReceived(event), getUncodedPacked(event),
        getUncodedByCargo(event)])
      return NextResponse.json({ boxes, uncoded, uncodedPacked, uncodedByCargo },
        { headers: { "Cache-Control": "no-store" } })
    }
    return NextResponse.json({ error: "receipt or event is required" }, { status: 400 })
  } catch (err) {
    console.error("Failed to read the dispatch manifest:", err)
    return NextResponse.json({ error: "Failed to read the manifest" }, { status: 500 })
  }
}
