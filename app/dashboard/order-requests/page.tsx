import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import OrderRequestsClient from "./OrderRequestsClient"

export default function OrderRequestsPage() {
  return (
    <PageShell>
      <PageHeader title="Order Requests" subtitle="Review catalogue requests and convert them into orders" />
      <OrderRequestsClient />
    </PageShell>
  )
}
