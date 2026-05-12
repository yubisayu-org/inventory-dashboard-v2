import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import ExcessTable from "./ExcessTable"

export default function ExcessPurchasePage() {
  return (
    <PageShell>
      <PageHeader
        title="Excess Purchase"
        subtitle="Ready stock — overbuys, overships, and wrong-product receipts"
      />
      <ExcessTable />
    </PageShell>
  )
}
