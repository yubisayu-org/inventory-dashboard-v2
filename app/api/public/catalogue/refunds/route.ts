import { NextRequest, NextResponse } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"
import catalogueSql from "@/lib/db-catalogue-public"
import {
  getCustomerRefunds,
  chooseRefundCredit,
  chooseRefundBank,
} from "@/lib/db/catalogue-refunds"
import { withActor } from "@/lib/db"

// What is coming back to her, and which way she wants it.
//
// Read on catalogue_public, which has SELECT and nothing else on `refunds`.
// Write on the main pool, because "she may move it to ready_to_refund but
// never to refunded" is a rule and a grant cannot say it — the rule lives in
// lib/db/catalogue-refunds.ts, and every statement there is scoped to her own
// handle taken from the verified session.

const MAX_BODY_BYTES = 2 * 1024

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }
  try {
    const refunds = await getCustomerRefunds(customer.instagramId, catalogueSql)
    return NextResponse.json({ refunds }, { headers: privateHeaders() })
  } catch (err) {
    console.error("Failed to load customer refunds:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500, headers: corsHeaders() })
  }
}

export async function POST(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders() })
  }

  let body: { id?: unknown; choice?: unknown; bank?: unknown; accountNumber?: unknown; accountHolder?: unknown }
  try {
    body = JSON.parse(raw || "{}")
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  const id = Number(body.id)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "id is required" }, { status: 400, headers: corsHeaders() })
  }

  try {
    // The actor is her own handle: a refund's history should say who chose,
    // and "the customer" is the honest answer for these two transitions.
    if (body.choice === "credit") {
      await withActor(`customer:${customer.instagramId}`, (tx) =>
        chooseRefundCredit(id, customer.instagramId, tx))
    } else if (body.choice === "bank") {
      await withActor(`customer:${customer.instagramId}`, (tx) =>
        chooseRefundBank(id, customer.instagramId, {
          bank: String(body.bank ?? ""),
          accountNumber: String(body.accountNumber ?? ""),
          accountHolder: String(body.accountHolder ?? ""),
        }, tx))
    } else {
      return NextResponse.json({ error: "choice must be credit or bank" }, { status: 400, headers: corsHeaders() })
    }
    return NextResponse.json({ ok: true }, { headers: privateHeaders() })
  } catch (err) {
    // Everything these throw is hers to act on: a closed refund, a bank she
    // has not picked, an account number that is not one.
    const message = err instanceof Error ? err.message : "Gagal menyimpan pilihan"
    console.error("Failed to record refund choice:", err)
    return NextResponse.json({ error: message }, { status: 400, headers: corsHeaders() })
  }
}
