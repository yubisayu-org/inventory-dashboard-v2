import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import AnnouncementsClient from "./AnnouncementsClient"

export default function AnnouncementsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Announcements"
        subtitle="Write a message every signed-in customer sees in their inbox"
      />
      <AnnouncementsClient />
    </PageShell>
  )
}
