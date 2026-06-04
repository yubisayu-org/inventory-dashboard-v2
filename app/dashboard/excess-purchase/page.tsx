import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import ExcessTable from "./ExcessTable"

export default function ExcessPurchasePage() {
  return (
    <PageShell>
      <PageHeader
        title="Inventory"
        subtitle="Ready stock — overbuys, overships, wrong-product and broken receipts"
      />
      <ExcessTable />
    </PageShell>
  )
}
