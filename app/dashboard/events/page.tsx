import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import EventsClient from "./EventsClient"

export default function EventsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Events"
        subtitle="Manage buying events"
      />
      <EventsClient />
    </PageShell>
  )
}
