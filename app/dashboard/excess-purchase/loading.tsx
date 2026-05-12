import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Excess Purchase" subtitle="Items purchased beyond total ordered quantity" />
      <TableSkeleton />
    </PageShell>
  )
}
