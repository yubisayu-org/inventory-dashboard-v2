import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { auth } from "@/auth"
import InvoiceClient from "./InvoiceClient"

export default async function InvoicePage() {
  // Cancelling refunds money and moves stock, so the API admits only the
  // owner. A button that always fails is worse than no button.
  const session = await auth()
  const isOwner = session?.user?.role === "owner"
  return (
    <PageShell>
      <PageHeader
        title="Invoice"
        subtitle="Look up a customer's orders and invoice totals"
      />
      <InvoiceClient isOwner={isOwner} />
    </PageShell>
  )
}
