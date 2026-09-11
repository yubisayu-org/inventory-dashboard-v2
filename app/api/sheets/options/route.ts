import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getCachedSheetOptions } from "@/lib/db/sheet-options-cache"

export async function GET(req: NextRequest) {
  const { session, error } = await requireSession()
  if (error) return error

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    // ?fresh=1 is the just-added-something case; see the cache's own note.
    const fresh = req.nextUrl.searchParams.get("fresh") === "1"
    const { options, fingerprint } = await getCachedSheetOptions({ fresh })
    const etag = `W/"${fingerprint}"`

    // Nothing has been written to any of the four tables since this browser
    // last asked, so it already holds the answer. 304 carries no body.
    if (!fresh && req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "no-cache" },
      })
    }

    // no-cache rather than no-store: the browser must revalidate every time --
    // a product added upstairs still has to appear in the picker downstairs --
    // but it may keep the copy it has and be told it is still good.
    return NextResponse.json(options, {
      headers: { ETag: etag, "Cache-Control": "no-cache" },
    })
  } catch (err) {
    console.error("Sheets API error:", err)
    return NextResponse.json({ error: "Failed to fetch sheet data" }, { status: 500 })
  }
}
