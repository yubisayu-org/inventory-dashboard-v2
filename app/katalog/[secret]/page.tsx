import type { Viewport } from "next"
import KatalogClient from "./KatalogClient"

/**
 * Zoom is the point of this page, so the app-wide lock is lifted here.
 *
 * The root layout disables pinch — iOS otherwise auto-zooms into small inputs
 * and will not zoom back out, which is right for a form-heavy admin tool. A
 * customer reading a price tag off a shelf has the opposite need, and this
 * page has no inputs to be zoomed into.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 6,
  userScalable: true,
  viewportFit: "cover",
}

export const metadata = {
  title: "Katalog rak",
  // A shelf photo is not something to have indexed: the link is meant to be
  // shared by the owner, not found.
  robots: { index: false, follow: false },
}

export default async function KatalogPage({
  params,
}: {
  params: Promise<{ secret: string }>
}) {
  const { secret } = await params
  return <KatalogClient secret={secret} />
}
