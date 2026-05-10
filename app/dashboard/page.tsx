import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import DashboardClient from "./DashboardClient"

export default function DashboardPage() {
  return (
    <PageShell>
      <PageHeader title="Dashboard" subtitle="What needs your attention" />
      <DashboardClient />
    </PageShell>
  )
}
