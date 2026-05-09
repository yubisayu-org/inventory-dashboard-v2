import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import PaymentsClient from "./PaymentsClient"

export default function PaymentsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Payments"
        subtitle="Track customer payments per event"
      />
      <PaymentsClient />
    </PageShell>
  )
}
