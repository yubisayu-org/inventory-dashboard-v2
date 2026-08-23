import PageShell from "@/components/PageShell"
import { auth } from "@/auth"
import ShopPostClient from "./ShopPostClient"

export default async function ShopPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  // The tally is the owner's alone: the count is what the shelf is reconciled
  // against, and it cannot be checked afterwards from the photograph. Everything
  // else on this screen — naming, pricing, orders — an admin does beside her.
  const canTally = session?.user?.role === "owner"
  return (
    <PageShell>
      <ShopPostClient postId={Number(id)} canName canTally={canTally} />
    </PageShell>
  )
}
