import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import AdjustmentsClient from "./AdjustmentsClient"

export default function AdjustmentsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Adjustments"
        subtitle="Extra fees and discounts per customer per event"
      />
      <AdjustmentsClient />
    </PageShell>
  )
}
