import type { Viewport } from "next"
import KatalogClient from "./KatalogClient"

/**
 * Page zoom stays off; the shelf zooms itself.
 *
 * Pinching the page scaled the pen colour, Undo and Kirim along with the
 * photograph, and on iOS left the fixed bar drifting around the visual
 * viewport. The marking screen transforms its own canvas instead, so this page
 * keeps the app-wide lock inherited from the root layout — repeated here
 * because it is a decision, not an oversight.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
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
