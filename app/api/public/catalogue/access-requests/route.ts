import { NextRequest, NextResponse } from "next/server"
import catalogueSql from "@/lib/db-catalogue-public"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"

// Public intake for people the shop has no customers row for. Anyone who has
// ordered before already has one, so they never come through here — the shop
// re-issues their invite instead.

const MAX_BODY_BYTES = 4 * 1024
const MAX_HANDLE_LEN = 30 // Instagram's own maximum
const MAX_NOTE_LEN = 300

// Reachable without a session by definition, so the most exposed write here.
// The catalogue's proxy limits per IP too, but this endpoint is directly
// reachable and must not depend on its caller for that.
const RATE_LIMIT_WINDOW = 60_000
const RATE_LIMIT_MAX = 5

const rateLimit = new Map<string, { windowStart: number; count: number }>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimit.get(ip)
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimit.set(ip, { windowStart: now, count: 1 })
    return false
  }
  entry.count++
  return entry.count > RATE_LIMIT_MAX
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many requests. Please try again in a minute." },
      { status: 429, headers: corsHeaders() },
    )
  }

  const declared = Number(req.headers.get("content-length") ?? 0)
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders() })
  }

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders() })
  }

  let body: { instagramHandle?: unknown; note?: unknown }
  try {
    body = JSON.parse(raw || "{}")
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  const handle = String(body.instagramHandle ?? "").trim().replace(/^@/, "").toLowerCase()
  const note = String(body.note ?? "").trim().slice(0, MAX_NOTE_LEN)

  if (!handle || handle.length > MAX_HANDLE_LEN) {
    return NextResponse.json(
      { error: `instagramHandle is required and must be ${MAX_HANDLE_LEN} characters or fewer` },
      { status: 400, headers: corsHeaders() },
    )
  }

  try {
    // Column-scoped INSERT: status and customer_id are staff decisions, and
    // the grant does not let a caller set either.
    // One pending request per handle: repeated submissions should not bury
    // the staff queue under duplicates of the same person asking twice.
    await catalogueSql`
      INSERT INTO catalogue_access_requests (instagram_id, note)
      SELECT ${handle}, ${note}
       WHERE NOT EXISTS (
         SELECT 1 FROM catalogue_access_requests
          WHERE instagram_id = ${handle} AND status = 'pending'
       )
    `
    return NextResponse.json({ ok: true }, { status: 201, headers: privateHeaders() })
  } catch (err) {
    console.error("Failed to queue catalogue access request:", err)
    return NextResponse.json({ error: "Failed to send request" }, { status: 500, headers: corsHeaders() })
  }
}
