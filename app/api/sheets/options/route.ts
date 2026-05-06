import { NextResponse } from "next/server"
import { requireSession } from "@/lib/api"
import { getSheetOptions } from "@/lib/db"

export async function GET() {
  const { error } = await requireSession()
  if (error) return error

  try {
    const options = await getSheetOptions()
    return NextResponse.json(options)
  } catch (err) {
    console.error("Sheets API error:", err)
    return NextResponse.json({ error: "Failed to fetch sheet data" }, { status: 500 })
  }
}
