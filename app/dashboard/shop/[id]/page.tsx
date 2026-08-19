import PageShell from "@/components/PageShell"
import { auth } from "@/auth"
import ShopPostClient from "./ShopPostClient"

export default async function ShopPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  // Naming creates products and orders, so it stays owner-only even though the
  // counting screen around it is open to admins.
  const canName = session?.user?.role === "owner"
  return (
    <PageShell>
      <ShopPostClient postId={Number(id)} canName={canName} />
    </PageShell>
  )
}
