import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import CatalogueAccessClient from "./CatalogueAccessClient"

export default function CatalogueAccessPage() {
  return (
    <PageShell>
      <PageHeader
        title="Catalogue Access"
        subtitle="Approve access requests, send sign-in links, and revoke customers"
      />
      <CatalogueAccessClient />
    </PageShell>
  )
}
