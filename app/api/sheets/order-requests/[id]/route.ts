import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { convertCatalogueRequest, rejectCatalogueRequest, editCatalogueRequest, cancelEditCatalogueRequest } from "@/lib/db"

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const body = await req.json()

    if (body.action === "convert") {
      const event = String(body.event ?? "")
      if (!event) return NextResponse.json({ error: "event is required" }, { status: 400 })

      const productIdRaw = body.productId
      let productId: number | undefined
      if (productIdRaw !== undefined && productIdRaw !== null) {
        productId = Number(productIdRaw)
        if (!Number.isInteger(productId) || productId < 1) {
          return NextResponse.json({ error: "productId must be a positive integer" }, { status: 400 })
        }
      }

      try {
        const result = await convertCatalogueRequest(id, event, session.user.email ?? null, productId)
        return NextResponse.json({ success: true, orderId: result.orderId })
      } catch (err) {
        if (isGuardViolation(err)) return NextResponse.json({ error: err.message }, { status: 409 })
        if (isUserActionable(err)) return NextResponse.json({ error: err.message }, { status: 400 })
        throw err
      }
    }

    if (body.action === "reject") {
      const staffNote = String(body.staffNote ?? "")
      try {
        await rejectCatalogueRequest(id, staffNote)
        return NextResponse.json({ success: true })
      } catch (err) {
        if (isGuardViolation(err)) return NextResponse.json({ error: err.message }, { status: 409 })
        throw err
      }
    }

    if (body.action === "edit") {
      const countryId = Number(body.countryId)
      const valas = Number(body.valas)
      const gram = Number(body.gram)
      if (!Number.isInteger(countryId) || countryId < 1) {
        return NextResponse.json({ error: "countryId must be a positive integer" }, { status: 400 })
      }
      if (!Number.isFinite(valas) || valas <= 0) {
        return NextResponse.json({ error: "valas must be a positive number" }, { status: 400 })
      }
      if (!Number.isFinite(gram) || gram <= 0) {
        return NextResponse.json({ error: "gram must be a positive number" }, { status: 400 })
      }
      try {
        const result = await editCatalogueRequest(id, { countryId, valas, gram })
        return NextResponse.json({ success: true, estimatedPrice: result.estimatedPrice })
      } catch (err) {
        if (isGuardViolation(err)) return NextResponse.json({ error: err.message }, { status: 409 })
        if (err instanceof Error && err.message === "Country not found") {
          return NextResponse.json({ error: err.message }, { status: 400 })
        }
        throw err
      }
    }

    if (body.action === "cancel-edit") {
      try {
        await cancelEditCatalogueRequest(id)
        return NextResponse.json({ success: true })
      } catch (err) {
        if (isGuardViolation(err)) return NextResponse.json({ error: err.message }, { status: 409 })
        throw err
      }
    }

    return NextResponse.json({ error: "action must be 'convert', 'reject', 'edit', or 'cancel-edit'" }, { status: 400 })
  } catch (err) {
    console.error("Failed to update order request:", err)
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update request" }, { status: 500 })
  }
}

// `convertCatalogueRequest`/`rejectCatalogueRequest` (lib/db/catalogue-requests.ts) throw this
// exact message when the request is already converted/rejected or doesn't exist — a
// user-actionable guard violation, not a server error. Matches the specific-catch treatment in
// app/api/sheets/duplicate-form/[row]/route.ts (returnOrderUnitsToExcess guard).
function isGuardViolation(err: unknown): err is Error {
  return err instanceof Error && err.message === "Request not found or already handled"
}

// convertCatalogueRequest throws these two exact messages when a custom
// request (no tagged product) is converted without staff picking one, or
// with a productId that no longer resolves to a real product — both are
// user-actionable input problems (400), distinct from the "someone else
// already handled it" race isGuardViolation covers (409).
function isUserActionable(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.message === "A product must be selected to convert a custom request" ||
      err.message === "Selected product not found")
  )
}
