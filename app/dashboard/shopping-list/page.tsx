import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import ShoppingListClient from "./ShoppingListClient"

export default function ShoppingListPage() {
  return (
    <PageShell>
      <PageHeader
        title="Shopping List"
        subtitle="Items to buy — orders not yet purchased"
      />
      <ShoppingListClient />
    </PageShell>
  )
}
