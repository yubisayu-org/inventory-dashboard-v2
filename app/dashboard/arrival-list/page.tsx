import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import ArrivalListClient from "./ArrivalListClient"
import Link from "next/link"

export default function ArrivalListPage() {
  return (
    <PageShell>
      <PageHeader
        title="Receiving List"
        subtitle="Track which purchased items haven't arrived yet"
      />
      {/* Same as the dispatch side: the report is made where the boxes are.
          Its date range went with it -- the scope is a box, a family or a
          trip now, and the arrivals nobody coded are a group of their own
          rather than a week to guess at. */}
      <p className="mb-4 text-sm text-muted">
        Received reports are on{" "}
        <Link href="/dashboard/box" className="font-medium text-brand hover:underline">Box Manifest</Link>.
      </p>
      <ArrivalListClient />
    </PageShell>
  )
}
