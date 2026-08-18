import KatalogClient from "./KatalogClient"

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
