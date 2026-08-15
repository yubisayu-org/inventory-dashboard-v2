import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import CataloguePostsClient from "./CataloguePostsClient"

export default function CataloguePostsPage() {
  return (
    <PageShell>
      <PageHeader title="Catalogue Posts" subtitle="Upload photos/videos and tag the products they show" />
      <CataloguePostsClient />
    </PageShell>
  )
}
