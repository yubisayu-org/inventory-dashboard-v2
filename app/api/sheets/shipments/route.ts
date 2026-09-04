import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getShippingRecords, updateTrackingNumber, updateShipmentTempAddress, withActor } from "@/lib/db"
import { recordChargedWeight } from "@/lib/db/parcel-plan"
import { repriceShippedRedirect } from "@/lib/db/redirect-ongkir"

// Default recent window (days) for the shipments list, so the payload stays
// bounded as shipment history grows. `?days=all` loads the full history.
const DEFAULT_WINDOW_DAYS = 90

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const daysParam = req.nextUrl.searchParams.get("days")
    let sinceDays: number | null = DEFAULT_WINDOW_DAYS
    if (daysParam === "all") {
      sinceDays = null
    } else if (daysParam) {
      const parsed = parseInt(daysParam, 10)
      if (Number.isFinite(parsed) && parsed > 0) sinceDays = parsed
    }

    const data = await getShippingRecords(sinceDays)
    return NextResponse.json(data)
  } catch (err) {
    console.error("Failed to load shipments:", err)
    return NextResponse.json({ error: "Failed to load shipments" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json() as {
      rowNumber?: number
      trackingNumber?: string
      // null clears, string sets, undefined means "don't touch this field"
      tempAddress?: string | null
      // The parts behind that label. An area is what makes a correction
      // priceable, and what tells a street being retyped apart from a parcel
      // going to another city.
      areaId?: string
      areaName?: string
      name?: string
      phone?: string
      /** Charge the difference the new area makes. Never assumed: a person
       *  decides whether the box really went somewhere else. */
      repriceOngkir?: boolean
      // null clears a correction: the estimate was right after all.
      weightCharged?: number | null
    }
    const {
      rowNumber, trackingNumber, tempAddress, weightCharged,
      areaId, areaName, name, phone, repriceOngkir,
    } = body
    if (!rowNumber) {
      return NextResponse.json({ error: "rowNumber is required" }, { status: 400 })
    }
    // PATCH lets the caller update either field independently, mirroring how
    // the page surfaces them (inline edits for tracking number and for temp
    // address are two separate flows).
    if (trackingNumber !== undefined) {
      if (typeof trackingNumber !== "string") {
        return NextResponse.json({ error: "trackingNumber must be a string" }, { status: 400 })
      }
      await withActor(session.user.email, (tx) => updateTrackingNumber(rowNumber, trackingNumber, tx))
    }
    if (tempAddress !== undefined) {
      if (tempAddress !== null && typeof tempAddress !== "string") {
        return NextResponse.json({ error: "tempAddress must be a string or null" }, { status: 400 })
      }
      await withActor(session.user.email, (tx) => updateShipmentTempAddress(rowNumber, tempAddress, tx, {
        areaId, areaName, name, phone,
      }))

      // Pressing Ship does not put the box on a van — the parcels are packed
      // one at a time, and a customer asking for somewhere else in that gap is
      // ordinary. So a corrected area re-prices, and only when somebody says
      // so: the figure was shown to them before they pressed save.
      if (repriceOngkir && tempAddress && areaId) {
        await withActor(session.user.email, (tx) =>
          repriceShippedRedirect(rowNumber, areaId, areaName ?? "", true, tx))
      }
    }
    if (weightCharged !== undefined) {
      if (weightCharged !== null && (!Number.isInteger(weightCharged) || weightCharged < 1)) {
        return NextResponse.json(
          { error: "weightCharged must be a whole number of kilos, or null" },
          { status: 400 },
        )
      }
      // Changes what a customer owes, so it runs through the same path the
      // tests cover rather than writing the column directly.
      await recordChargedWeight(rowNumber, weightCharged, session.user.email)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to update shipment:", err)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
  }
}
