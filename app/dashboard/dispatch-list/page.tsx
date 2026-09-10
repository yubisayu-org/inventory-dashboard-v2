import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import DispatchListClient from "./DispatchListClient"
import Link from "next/link"

export default function DispatchListPage() {
  return (
    <PageShell>
      <PageHeader
        title="Dispatch List"
        subtitle="Bought orders not yet dispatched"
      />
      {/* The document moved to Box Manifest, where every receipt it could be
          narrowed by is a card you can tap. This line is the signpost for
          anyone who comes here looking for the old panel. */}
      <p className="mb-4 text-sm text-muted">
        Dispatch documents are on{" "}
        <Link href="/dashboard/box" className="font-medium text-brand hover:underline">Box Manifest</Link>.
      </p>
      <DispatchListClient />
    </PageShell>
  )
}
