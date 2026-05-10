import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import RefundsClient from "./RefundsClient"

export default function RefundsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Refunds"
        subtitle="Track and process customer refunds"
      />
      <RefundsClient />
    </PageShell>
  )
}
