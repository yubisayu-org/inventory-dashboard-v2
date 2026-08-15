import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Order Requests" subtitle="Review catalogue requests and convert them into orders" />
      <TableSkeleton />
    </PageShell>
  )
}
