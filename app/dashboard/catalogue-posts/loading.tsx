import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Catalogue Posts" subtitle="Upload photos/videos and tag the products they show" />
      <TableSkeleton />
    </PageShell>
  )
}
