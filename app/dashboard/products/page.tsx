import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import ProductsPageClient from "./ProductsPageClient"

export default function ProductsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Products"
        subtitle="Manage product catalogue and pricing"
      />
      <ProductsPageClient />
    </PageShell>
  )
}
