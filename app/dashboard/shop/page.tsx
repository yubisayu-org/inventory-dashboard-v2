import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import ShopClient from "./ShopClient"

export default function ShopPage() {
  return (
    <PageShell>
      <PageHeader
        title="Group Order"
        subtitle="Count what you actually found, one shelf at a time"
      />
      <ShopClient />
    </PageShell>
  )
}
