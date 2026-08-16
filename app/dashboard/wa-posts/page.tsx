import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import PostsClient from "./PostsClient"

export default function WaPostsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Group Posts"
        subtitle="Shelves posted to WhatsApp, and what customers claimed on them"
      />
      <PostsClient />
    </PageShell>
  )
}
