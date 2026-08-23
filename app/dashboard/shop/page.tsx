import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { auth } from "@/auth"
import ShopClient from "./ShopClient"

export default async function ShopPage() {
  const session = await auth()
  // Same reasoning as the shelf detail page: posting to the group is
  // owner-only even though the counting screen around it is open to admins.
  const isOwner = session?.user?.role === "owner"
  return (
    <PageShell>
      <PageHeader
        title="Group Order"
        subtitle="Count what you actually found, one shelf at a time"
      />
      <ShopClient isOwner={isOwner} />
    </PageShell>
  )
}
